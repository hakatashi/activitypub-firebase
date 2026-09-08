'use strict'
const crypto = require('crypto')
// http communication middleware
module.exports = {
  requireAuthorized,
  requireAuthorizedOrPublic,
  verifyAuthorization,
  verifySignature,
  parseSignatureHeader,
  buildStringToSign,
  verifyHttpSignature
}

function requireAuthorized (req, res, next) {
  const locals = res.locals.apex
  if (!locals.authorized) {
    return res.sendStatus(403)
  }
  return next()
}

function requireAuthorizedOrPublic (req, res, next) {
  const apex = req.app.locals.apex
  const locals = res.locals.apex
  if (locals.target && !(apex.isPublic(locals.target) || locals.authorized)) {
    return res.sendStatus(403)
  }
  return next()
}

function verifyAuthorization (req, res, next) {
  const apex = req.app.locals.apex
  const locals = res.locals.apex
  // if not already set, check for PassportJS-style auth
  if (locals.authorizedUserId == null) {
    locals.authorizedUserId = req.user?.username &&
      apex.utils.usernameToIRI(req.user.username)
  }
  // if not already set, check authorization via ownership
  if (locals.authorized == null) {
    locals.authorized = locals.target && locals.authorizedUserId &&
      apex.validateOwner(locals.target, { id: locals.authorizedUserId })
  }
  next()
}

function parseSignatureHeader (rawHeader) {
  if (!rawHeader || typeof rawHeader !== 'string') {
    return null
  }
  let header = rawHeader.trim()
  if (header.toLowerCase().startsWith('signature ')) {
    header = header.slice('signature '.length).trim()
  }
  const params = {}
  const parts = header.split(',')
  for (const part of parts) {
    const match = /^\s*([A-Za-z]+)\s*=\s*"([^"]*)"\s*$/.exec(part)
    if (!match) {
      return null
    }
    params[match[1]] = match[2]
  }
  if (!params.keyId || !params.signature) {
    return null
  }
  const headers = params.headers
    ? params.headers.toLowerCase().split(/\s+/).filter(Boolean)
    : ['date']
  return {
    keyId: params.keyId,
    algorithm: (params.algorithm || 'rsa-sha256').toLowerCase(),
    headers,
    signature: params.signature
  }
}

function buildStringToSign (req, headerNames) {
  const lines = []
  for (const name of headerNames) {
    const lowerName = name.toLowerCase()
    if (lowerName === '(request-target)') {
      const path = req.originalUrl || req.url
      lines.push(`(request-target): ${req.method.toLowerCase()} ${path}`)
    } else if (lowerName === 'host') {
      const host = req.get('host') ?? req.headers.host
      if (host === undefined) {
        return null
      }
      lines.push(`host: ${host}`)
    } else {
      const val = req.get(lowerName) ?? req.headers[lowerName]
      if (val === undefined) {
        return null
      }
      lines.push(`${lowerName}: ${val}`)
    }
  }
  return lines.join('\n')
}

function verifyHttpSignature (sigHead, stringToSign, publicKeyPem) {
  let hashAlgo = 'sha256'
  const algo = sigHead.algorithm.toLowerCase()
  if (algo === 'rsa-sha256' || algo === 'hs2019') {
    hashAlgo = 'sha256'
  } else if (algo === 'rsa-sha512') {
    hashAlgo = 'sha512'
  } else if (algo === 'rsa-sha1') {
    hashAlgo = 'sha1'
  } else {
    return false
  }

  try {
    const signatureBuffer = Buffer.from(sigHead.signature, 'base64')
    return crypto.verify(
      hashAlgo,
      Buffer.from(stringToSign, 'utf-8'),
      publicKeyPem,
      signatureBuffer
    )
  } catch (err) {
    return false
  }
}

async function verifySignature (req, res, next) {
  const apex = req.app.locals.apex
  const signatureHeader = req.get('signature') || req.get('authorization')

  if (!signatureHeader) {
    if (req.app.get('env') !== 'development') {
      apex.logger.warn('Request rejected: missing http signature')
      return res.status(401).send('Missing http signature')
    }
    try {
      const actor = await apex.resolveObject(apex.actorIdFromActivity(req.body))
      res.locals.apex.sender = actor
      return next()
    } catch (err) {
      apex.logger.warn('error resolving actor in dev mode', err)
      return res.status(500).send()
    }
  }

  const sigHead = parseSignatureHeader(signatureHeader)
  if (!sigHead) {
    apex.logger.warn('Request rejected: unsupported or invalid signature header format')
    return res.status(403).send('Invalid http signature')
  }

  const stringToSign = buildStringToSign(req, sigHead.headers)
  if (stringToSign === null) {
    apex.logger.warn('Request rejected: signed headers missing from request')
    return res.status(403).send('Invalid http signature')
  }

  const type = req.body?.type ? req.body.type.toLowerCase() : ''
  let cached = true
  let signer
  try {
    signer = await apex.resolveObject(sigHead.keyId, false, false, true)
    if ((type === 'delete' || type === 'update') && (!signer || signer.type.toLowerCase() === 'tombstone')) {
      console.log('Ignoring unverifiable %s from %s', type, req.body.actor)
      // user delete message that can't be verified because we don't have the user cached
      return res.status(200).send()
    } else if (!signer) {
      console.log('Fetching actor to verify signature %s', sigHead.keyId)
      cached = false
      signer = await apex.resolveObject(sigHead.keyId)
    }
  } catch (err) {
    apex.logger.warn('error resolving signer for signature verification', err)
    return res.status(500).send()
  }

  if (!signer || !signer.publicKey?.[0]?.publicKeyPem?.[0]) {
    apex.logger.warn('Could not find key for %s %j', sigHead.keyId, signer)
    return res.status(403).send('Invalid http signature')
  }

  let valid = verifyHttpSignature(sigHead, stringToSign, signer.publicKey[0].publicKeyPem[0])
  if (!valid && cached) {
    console.log('Refreshing key for %s', sigHead.keyId)
    // try refreshing cached key in case of key rotation
    try {
      signer = await apex.resolveObject(sigHead.keyId, false, true)
    } catch (err) {
      apex.logger.warn('error refreshing key for signature verification', err)
      return res.status(500).send()
    }
    if (signer?.publicKey?.[0]?.publicKeyPem?.[0]) {
      valid = verifyHttpSignature(sigHead, stringToSign, signer.publicKey[0].publicKeyPem[0])
    }
  }

  if (!valid) {
    apex.logger.warn('Request rejected: invalid http signature')
    return res.status(403).send('Invalid http signature')
  }

  res.locals.apex.sender = signer
  next()
}
