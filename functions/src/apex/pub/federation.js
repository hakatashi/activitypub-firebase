'use strict'
const { Agent, request } = require('undici')
const { assertSafeUrl } = require('./ssrf')
const crypto = require('crypto')

// federation communication utilities
module.exports = {
  deliver,
  queueForDelivery,
  requestObject,
  resolveReferences,
  runDelivery,
  startDelivery,
  makeUserAgentString,
  computeHttpSignature,
  computeHttpSignatureHeaders
}
const maxTimeout = Math.pow(2, 31) - 1
let isDelivering = false
let nextDelivery = null

function computeHttpSignature ({ method, url, headerNames, headerValues, keyId, privateKey }) {
  const signedHeaders = headerNames.map(name => {
    const lowerName = name.toLowerCase()
    if (lowerName === '(request-target)') {
      return [lowerName, `${method.toLowerCase()} ${url.pathname}${url.search}`]
    }
    if (lowerName === 'host') {
      return [lowerName, url.host]
    }
    const val = headerValues[lowerName]
    if (val === undefined) {
      throw new Error(`Missing header value for signature: ${name}`)
    }
    return [lowerName, val]
  })
  const stringToSign = signedHeaders.map(([name, val]) => `${name}: ${val}`).join('\n')
  const signature = crypto.sign('sha256', Buffer.from(stringToSign, 'utf-8'), privateKey).toString('base64')
  const signatureHeader = `keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaders.map(([name]) => name).join(' ')}",signature="${signature}"`
  return signatureHeader
}

/**
 * @param {object} options
 * @param {string} [options.method]
 * @param {URL | string} options.url
 * @param {string} options.keyId
 * @param {string} options.privateKeyPem
 * @param {string} [options.date]
 * @param {string} [options.digest]
 * @returns {{ date: string, signature: string, digest?: string }}
 */
function computeHttpSignatureHeaders ({
  method = 'get',
  url,
  keyId,
  privateKeyPem,
  date = new Date().toUTCString(),
  digest = undefined
}) {
  const parsedUrl = typeof url === 'string' ? new URL(url) : url
  const headerNames = ['(request-target)', 'host', 'date']
  const headerValues = { date }
  if (digest !== undefined) {
    headerNames.push('digest')
    headerValues.digest = digest
  }
  const signature = computeHttpSignature({
    method,
    url: parsedUrl,
    headerNames,
    headerValues,
    keyId,
    privateKey: privateKeyPem
  })
  const result = { date, signature }
  if (digest !== undefined) {
    result.digest = digest
  }
  return result
}

const maxRedirects = 5
const maxResponseBytes = 5 * 1024 * 1024

// assertSafeUrl が検証した IP アドレスに接続を固定する Agent を作る。lookup を差し替えることで、
// 接続時に DNS が再解決されて検証済みアドレスと異なる IP (攻撃者制御の DNS が返す
// private/loopback アドレス) に接続してしまう DNS rebinding を防ぐ。ホスト名自体は変えないため
// TLS の SNI / 証明書検証には影響しない。
function makePinnedAgent (addresses) {
  const toEntry = address => ({ address, family: address.includes(':') ? 6 : 4 })
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, addresses.map(toEntry))
        } else {
          const { address, family } = toEntry(addresses[0])
          callback(null, address, family)
        }
      }
    }
  })
}

async function readBodyWithLimit (body, headers) {
  const contentLength = headers['content-length']
  if (contentLength !== undefined && Number(contentLength) > maxResponseBytes) {
    // 破棄時に発火する AbortError を握りつぶす (呼び出し元へは下の Error を投げる)
    body.on('error', () => {})
    body.destroy()
    throw new Error(`Response too large: ${contentLength} bytes`)
  }
  const chunks = []
  let total = 0
  // ループ内で throw すると for await...of が body を破棄する
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > maxResponseBytes) {
      throw new Error(`Response exceeded ${maxResponseBytes} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// SSRF セーフなリモートオブジェクト取得。URL の検証 (スキーム / DNS 解決結果のアドレス範囲) を
// リダイレクトの各ホップで行い、検証済み IP に接続を固定する。何を内部とみなすかは
// settings.remoteFetchPolicy で注入できる (→ ssrf.js)。
async function requestObject (id) {
  const guardOptions = { policy: this.settings?.remoteFetchPolicy, logger: this.logger }
  let { url, addresses } = await assertSafeUrl(id, guardOptions)

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const headers = {
      Accept: 'application/activity+json',
      'User-Agent': this.makeUserAgentString()
    }
    if (this.systemUser && this.systemUser._meta?.privateKey) {
      const { date, signature } = computeHttpSignatureHeaders({
        method: 'get',
        url,
        // keyId には公開鍵の id (`#main-key`) を渡す必要がある
        keyId: `${this.systemUser.id}#main-key`,
        privateKeyPem: this.systemUser._meta.privateKey
      })
      headers.Date = date
      headers.Signature = signature
    }

    const agent = makePinnedAgent(addresses)
    let response
    try {
      response = await request(url, {
        method: 'GET',
        headers,
        headersTimeout: this.requestTimeout,
        bodyTimeout: this.requestTimeout,
        dispatcher: agent
      })

      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location
        await response.body.dump()
        if (!location) {
          throw new Error(`Redirect from ${url.toString()} is missing Location header`)
        }
        ;({ url, addresses } = await assertSafeUrl(new URL(location, url).toString(), guardOptions))
        continue
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump()
        throw new Error(`Request failed with status code ${response.statusCode}`)
      }

      const body = await readBodyWithLimit(response.body, response.headers)
      return await this.fromJSONLD(JSON.parse(body))
    } finally {
      await agent.close()
    }
  }

  this.logger.warn({ type: 'ssrfBlockedTooManyRedirects', url: id })
  throw new Error(`Too many redirects while fetching ${id}`)
}

const refProps = ['inReplyTo', 'object', 'target', 'tag']
async function resolveReferences (object, depth = 0) {
  const objectPromises = refProps.map(prop => object[prop])
    .flat() // may have multiple tags to resolve
    .map(o => this.resolveUnknown(o))
    .filter(p => p)
  const objects = (await Promise.allSettled(objectPromises))
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
  if (!objects.length || depth >= this.threadDepth) {
    return objects
  }
  const nextLevel = objects
    .map(o => this.resolveReferences(o, depth + 1))
  const nextLevelResolved = (await Promise.allSettled(nextLevel))
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
  return objects.concat(nextLevelResolved.flat())
}

async function deliver (actorId, activity, address, signingKey) {
  if (this.isProductionEnv() && this.isLocalhostIRI(address)) {
    return null
  }
  const url = new URL(address)
  // digest header added for Mastodon 3.2.1 compatibility
  const digest = 'SHA-256=' + crypto.createHash('sha256')
    .update(activity)
    .digest('base64')
  const date = new Date().toUTCString()
  const headers = {
    'Content-Type': this.consts.jsonldOutgoingType,
    Date: date,
    Digest: digest,
    Host: url.host,
    'User-Agent': this.makeUserAgentString()
  }
  if (signingKey) {
    const { signature } = computeHttpSignatureHeaders({
      method: 'post',
      url,
      keyId: actorId,
      privateKeyPem: signingKey,
      date,
      digest
    })
    headers.Signature = signature
  }

  const response = await request(url, {
    method: 'POST',
    headers,
    body: activity,
    headersTimeout: this.requestTimeout,
    bodyTimeout: this.requestTimeout
  })

  const body = await response.body.text()

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body
  }
}

async function queueForDelivery (actor, activity, addresses) {
  // custom stringify strips meta props
  const outgoingBody = this.stringifyPublicJSONLD(activity)
  await this.store
    .deliveryEnqueue(actor.id, outgoingBody, addresses, actor._meta.privateKey)
  // returning promise makes first delivery complete during postWork (easier testing)
  return this.startDelivery()
}

function startDelivery () {
  if (isDelivering || this.offlineMode) {
    return
  }
  return this.runDelivery()
}

async function runDelivery () {
  isDelivering = true
  const toDeliver = await this.store.deliveryDequeue()
  if (!toDeliver) {
    isDelivering = false
    return
  }
  // only future-dated items left, resume then
  if (toDeliver.waitUntil) {
    const wait = Math.min(toDeliver.waitUntil.getTime() - Date.now(), maxTimeout)
    nextDelivery = setTimeout(() => this.startDelivery(), wait)
    isDelivering = false
    return
  }
  // if new delivery run starts while another is pending,
  // it will add another timer when it finishes
  clearTimeout(nextDelivery)
  try {
    const { actorId, body, address, signingKey } = toDeliver
    const result = await this.deliver(actorId, body, address, signingKey)
    this.logger.info('delivery:', address, result.statusCode)
    if (result.statusCode >= 500) {
      // 5xx errors will get requeued
      throw new Error(`Request status ${result.statusCode}`)
    }
  } catch (err) {
    this.logger.warn(`Delivery error ${err.message}, requeuing`)
    // 11 tries over ~5 months
    if (toDeliver.attempt < 11) {
      await this.store.deliveryRequeue(toDeliver).catch(err => {
        this.logger.error('Failed to requeue delivery', err.message)
      })
    }
    // TODO: consider tracking unreachable servers, removing followers
  }
  setTimeout(() => this.runDelivery(), 0)
}

function makeUserAgentString () {
  return `${this.settings.name}/${this.settings.version} (+http://${this.settings.domain})`
}
