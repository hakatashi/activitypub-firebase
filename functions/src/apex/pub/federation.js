'use strict'
const { request } = require('undici')
const crypto = require('crypto')

// federation communication utilities
module.exports = {
  deliver,
  queueForDelivery,
  requestObject,
  resolveReferences,
  runDelivery,
  startDelivery,
  makeUserAgentString
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

async function requestObject (id) {
  if (this.isProductionEnv() && this.isLocalhostIRI(id)) {
    return null
  }
  const url = new URL(id)
  const headers = {
    Accept: 'application/activity+json',
    'User-Agent': this.makeUserAgentString()
  }
  if (this.systemUser && this.systemUser._meta?.privateKey) {
    const date = new Date().toUTCString()
    headers.Date = date
    headers.Host = url.host
    const signature = computeHttpSignature({
      method: 'get',
      url,
      headerNames: ['(request-target)', 'host', 'date'],
      headerValues: { date },
      keyId: this.systemUser.id,
      privateKey: this.systemUser._meta.privateKey
    })
    headers.Signature = signature
  }

  const response = await request(url, {
    method: 'GET',
    headers,
    headersTimeout: this.requestTimeout,
    bodyTimeout: this.requestTimeout
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    await response.body.dump()
    throw new Error(`Request failed with status code ${response.statusCode}`)
  }

  const json = await response.body.json()
  return this.fromJSONLD(json)
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
    const signature = computeHttpSignature({
      method: 'post',
      url,
      headerNames: ['(request-target)', 'host', 'date', 'digest'],
      headerValues: { date, digest },
      keyId: actorId,
      privateKey: signingKey
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
