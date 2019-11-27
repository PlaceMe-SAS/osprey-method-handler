const is = require('type-is')
const extend = require('xtend')
const parseurl = require('parseurl')
const querystring = require('querystring')
const createError = require('http-errors')
const Negotiator = require('negotiator')
const standardHeaders = require('standard-headers')
const compose = require('compose-middleware').compose
const debug = require('debug')('osprey-method-handler')
const wp = require('webapi-parser')
const ramlSanitize = require('raml-sanitize')()
const lowercaseKeys = require('lowercase-keys')

const DEFAULT_OPTIONS = {
  discardUnknownBodies: true,
  discardUnknownQueryParameters: true,
  discardUnknownHeaders: true,
  parseBodiesOnWildcard: false,
  limit: '100kb',
  parameterLimit: 1000
}

/**
 * Get all default headers.
 *
 * @type {Object}
 */
const DEFAULT_REQUEST_HEADER_PARAMS = {}

// Fill header params with non-required parameters.
standardHeaders.request.forEach(function (header) {
  DEFAULT_REQUEST_HEADER_PARAMS[header] = new wp.model.domain.Parameter()
    .withName(header)
    .withRequired(false)
    .withSchema(new wp.model.domain.AnyShape().withName(header))
})

/**
 * Application body parsers and validators.
 *
 * @type {Array}
 */
const BODY_HANDLERS = [
  ['application/json', jsonBodyHandler],
  ['text/xml', xmlBodyHandler],
  ['application/x-www-form-urlencoded', urlencodedBodyHandler],
  ['multipart/form-data', formDataBodyHandler]
]

/**
 * Create a middleware request/response handler.
 *
 * @param  {webapi-parser.Operation} method
 * @param  {String}                  path
 * @param  {String}                  methodName
 * @param  {Object}                  options
 * @return {Function}
 */
function ospreyMethodHandler (method, path, methodName, options) {
  options = extend(DEFAULT_OPTIONS, options)

  const middleware = []

  // Attach the resource path to every validation handler.
  middleware.push(function resourcePathAttacher (req, res, next) {
    req.resourcePath = path
    return next()
  })
  const hasRequest = method && method.request

  // Headers *always* have a default handler.
  const headers = hasRequest ? method.request.headers : []
  middleware.push(headerHandler(headers, options))

  if (hasRequest && method.request.payloads.length > 0) {
    middleware.push(bodyHandler(
      method.request.payloads, path, methodName, options))
  } else if (options.discardUnknownBodies) {
    debug(
      '%s %s: Discarding body request stream: ' +
      'Use "*/*" or set "body" to accept content types',
      methodName,
      path
    )
    middleware.push(discardBody)
  }

  if (method && method.responses.length > 0) {
    middleware.push(acceptsHandler(method.responses, path, methodName))
  }

  if (hasRequest && method.request.queryParameters.length > 0) {
    middleware.push(queryHandler(method.request.queryParameters, options))
  } else if (options.discardUnknownQueryParameters) {
    debug(
      '%s %s: Discarding all query parameters: ' +
      'Define "queryParameters" to receive parameters',
      methodName,
      path
    )

    middleware.push(ospreyFastQuery)
  }
  return compose(middleware)
}

/**
 * Create a HTTP accepts handler.
 *
 * @param  {Array.<webapi-parser.Response>} responses
 * @param  {String}                         path
 * @param  {String}                         methodName
 * @return {Function}
 */
function acceptsHandler (responses, path, methodName) {
  const accepts = {}

  responses.filter(response => {
    const code = parseInt(response.statusCode.value())
    return code >= 200 && code < 300
  }).forEach(response => {
    response.payloads.forEach(body => {
      accepts[body.mediaType.value()] = true
    })
  })

  const mediaTypes = Object.keys(accepts)

  // The user will accept anything when there are no types defined.
  if (mediaTypes.length < 1) {
    debug('%s %s: No accepts media types defined', methodName, path)
    return []
  }

  const validTypes = mediaTypes.map(JSON.stringify).join(', ')
  const expectedMessage = mediaTypes.length === 1
    ? validTypes
    : `one of ${validTypes}`

  return function ospreyAccepts (req, res, next) {
    const negotiator = new Negotiator(req)

    if (!negotiator.mediaType(mediaTypes)) {
      return next(createError(
        406,
        `Unsupported accept header "${req.headers.accept}", expected ${expectedMessage}`
      ))
    }

    return next()
  }
}

/**
 * Create query string handling middleware.
 *
 * @param  {Array.<webapi-parser.Parameter>} queryParameters
 * @param  {Object}                          options
 * @return {Function}
 */
function queryHandler (queryParameters, options) {
  const sanitize = ramlSanitize(queryParameters)
  const parameters = {}
  queryParameters.forEach(qp => {
    parameters[qp.name.value().toLowerCase()] = qp
  })

  return async function ospreyQuery (req, res, next) {
    const reqUrl = parseurl(req)
    let query = sanitize(parseQuerystring(reqUrl.query))
    query = Object.fromEntries(
      Object.entries(query)
        .filter(([name, val]) => !!parameters[name]))

    if (options.discardUnknownQueryParameters) {
      const qs = querystring.stringify(query)
      req.url = reqUrl.pathname + (qs ? `?${qs}` : '')
      req.query = query
    } else {
      req.query = extend(req.query, query)
    }

    const reports = await Promise.all(
      Object.entries(req.query || {}).map(([name, value]) => {
        const param = parameters[name]
        return (param && param.schema)
          ? validateWithExtras(param, tryStringify(value))
          : Promise.resolve({ conforms: true })
      })
    )
    const failedReport = reports.filter(r => !r.conforms).pop()
    if (failedReport) {
      return next(createValidationError(
        formatRamlValidationReport(failedReport, 'query')))
    }

    return next()
  }
}

/**
 * Parse query strings with support for array syntax (E.g. `a[]=1&a[]=2`).
 */
function parseQuerystring (query) {
  return query
    ? querystring.parse(query.replace(/(?:%5B|\[)\d*(?:%5D|])=/ig, '='))
    : {}
}

/**
 * Create a request header handling middleware.
 *
 * @param  {Array.<webapi-parser.Parameter>} headers
 * @param  {Object}                          options
 * @return {Function}
 */
function headerHandler (headers = [], options) {
  let params = {}
  headers.map(header => {
    header.withName(header.name.value().toLowerCase())
    params[header.name.value()] = header
  })
  params = extend(DEFAULT_REQUEST_HEADER_PARAMS, params)
  params = lowercaseKeys(params)
  const sanitize = ramlSanitize(Object.values(params))

  return async function ospreyMethodHeader (req, res, next) {
    req.headers = lowercaseKeys(req.headers)
    // Unsets invalid headers. Does not touch `rawHeaders`.
    if (options.discardUnknownHeaders) {
      const definedHeaders = Object.entries(req.headers)
        .filter(([name, val]) => !!params[name])
      req.headers = Object.fromEntries(definedHeaders)
    }
    const reports = await Promise.all(
      Object.entries(req.headers || {}).map(([name, value]) => {
        const param = params[name]
        return param
          ? validateWithExtras(param, value)
          : Promise.resolve({ conforms: true })
      })
    )
    const failedReport = reports.filter(r => !r.conforms).pop()
    if (failedReport) {
      return next(createValidationError(
        formatRamlValidationReport(failedReport, 'header')))
    }
    req.header = sanitize(req.headers)
    return next()
  }
}

/**
 * Handle incoming request bodies.
 *
 * @param  {Array.<webapi-parser.Payload>} bodies
 * @param  {String}                        path
 * @param  {String}                        methodName
 * @param  {Object}                        options
 * @return {Function}
 */
function bodyHandler (bodies, path, methodName, options) {
  const bodyMap = {}

  bodies.forEach(body => {
    const type = body.mediaType.value()
    const handlers = BODY_HANDLERS.filter(([ct, handler]) => is.is(ct, type))
    // Do not parse on wildcards
    if (handlers.length > 1 && !options.parseBodiesOnWildcard) {
      return
    }

    // Attach existing handlers
    handlers.forEach(([contentType, handler]) => {
      bodyMap[contentType] = handler(body, path, methodName, options)
    })
  })

  const types = bodies.map(b => b.mediaType.value())
  const validTypes = types.map(JSON.stringify).join(', ')
  const expectedMessage = types.length === 1
    ? validTypes
    : `one of ${validTypes}`

  return function ospreyContentType (req, res, next) {
    const ct = req.headers['content-type']
    // Error when no body has been sent.
    if (!is.hasBody(req)) {
      return next(createError(
        415,
        `No body sent with request for ${req.method} ${req.originalUrl} ` +
        `with content-type "${ct}"`
      ))
    }

    const type = is.is(ct, types)

    if (!type) {
      return next(createError(
        415,
        `Unsupported content-type header "${ct}", expected ${expectedMessage}`
      ))
    }

    const fn = bodyMap[type]
    return fn ? fn(req, res, next) : next()
  }
}

/**
 * Handle JSON requests.
 *
 * @param  {webapi-parser.Payload} body
 * @param  {String}                path
 * @param  {String}                methodName
 * @param  {Object}                options
 * @return {Function}
 */
function jsonBodyHandler (body, path, methodName, options) {
  const jsonBodyParser = require('body-parser').json({
    type: [],
    strict: false,
    limit: options.limit,
    reviver: options.reviver
  })
  const middleware = [jsonBodyParser]

  // Check whether body.schema has type specified.
  // In case it's not specified, its type would be AnyShape, but
  // we can't check instance against it because it's a parent type
  // of multiple other types.
  const sclSchema = body.schema instanceof wp.model.domain.ScalarShape
  const objSchema = body.schema instanceof wp.model.domain.NodeShape
  const arrSchema = body.schema instanceof wp.model.domain.ArrayShape
  if (!sclSchema && !objSchema && !arrSchema) {
    return compose(middleware)
  }

  middleware.push(async function ospreyJsonBodyValidator (req, res, next) {
    const report = await validateWithExtras(body, JSON.stringify(req.body))
    if (!report.conforms) {
      return next(createValidationError(
        formatRamlValidationReport(report, 'body')))
    }
    return next()
  })

  if (!objSchema) {
    return compose(middleware)
  }

  // Validate minProperties
  const minProperties = body.schema.minProperties.option
  if (minProperties !== undefined && minProperties > 0) {
    middleware.push(function minPropertiesValidator (req, res, next) {
      if (Object.keys(req.body).length < minProperties) {
        return next(createValidationError(formatRamlErrors([{
          rule: 'minProperties',
          attr: minProperties
        }], 'json')))
      }

      return next()
    })
  }

  // Validate maxProperties
  const maxProperties = body.schema.maxProperties.option
  if (maxProperties !== undefined && maxProperties > 0) {
    middleware.push(function maxPropertiesValidator (req, res, next) {
      if (Object.keys(req.body).length > maxProperties) {
        return next(createValidationError(formatRamlErrors([{
          rule: 'maxProperties',
          attr: maxProperties
        }], 'json')))
      }

      return next()
    })
  }

  // Validate additionalProperties
  const additionalProperties = (
    !!body.schema.additionalPropertiesSchema ||
    body.schema.closed.value())
  if (!additionalProperties) {
    const schemaProps = body.schema.properties.map(p => p.name.value())
    middleware.push(function additionalPropertiesValidator (req, res, next) {
      const additionalPropertyFound = Object.keys(req.body)
        .some(key => schemaProps.indexOf(key) !== -1)

      if (additionalPropertyFound) {
        return next(createValidationError(formatRamlErrors([{
          rule: 'additionalProperties',
          attr: additionalProperties
        }], 'json')))
      }

      return next()
    })
  }

  return compose(middleware)
}

/**
 * Handle url encoded form requests.
 *
 * @param  {webapi-parser.Payload} body
 * @param  {String}                path
 * @param  {String}                methodName
 * @param  {Object}                options
 * @return {Function}
 */
function urlencodedBodyHandler (body, path, methodName, options) {
  const urlencodedBodyParser = require('body-parser').urlencoded({
    type: [],
    extended: false,
    limit: options.limit,
    parameterLimit: options.parameterLimit
  })
  const middleware = [urlencodedBodyParser]

  const hasProperties = body.schema && body.schema.properties.length > 0
  if (hasProperties) {
    const sanitize = ramlSanitize(body.schema.properties)
    middleware.push(async function ospreyUrlencodedBodyValidator (req, res, next) {
      const sanBody = sanitize(req.body)
      const report = await validateWithExtras(body, JSON.stringify(sanBody))
      if (!report.conforms) {
        return next(createValidationError(
          formatRamlValidationReport(report, 'form')))
      }
      req.body = sanBody
      return next()
    })
  }

  return compose(middleware)
}

/**
 * Handle XML requests.
 *
 * @param  {webapi-parser.Payload} body
 * @param  {String}                path
 * @param  {String}                methodName
 * @param  {Object}                options
 * @return {Function}
 */
function xmlBodyHandler (body, path, methodName, options) {
  const middleware = [xmlBodyParser(options)]

  if (body.schema instanceof wp.model.domain.SchemaShape) {
    middleware.push(xmlBodyValidationHandler(
      body.schema.raw.value(), path, methodName))
  }

  return compose(middleware)
}

/**
 * Parse an XML body request.
 *
 * @param  {Object}   options
 * @return {Function}
 */
function xmlBodyParser (options) {
  const libxml = getLibXml()
  const bodyParser = require('body-parser')
    .text({ type: [], limit: options.limit })

  // Parse the request body text.
  function xmlParser (req, res, next) {
    let xml

    try {
      xml = libxml.parseXml(req.body)
    } catch (err) {
      // Add a status code to indicate bad requests automatically.
      err.status = err.statusCode = 400
      return next(err)
    }

    // Assign parsed XML document to the body.
    req.xml = xml

    return next()
  }

  return compose([bodyParser, xmlParser])
}

/**
 * Require `libxmljs` with error messaging.
 *
 * @return {Object}
 */
function getLibXml () {
  let libxml

  try {
    libxml = require('libxmljs')
  } catch (err) {
    err.message = 'Install "libxmljs" using `npm install libxmljs --save` for XML validation'
    throw err
  }

  return libxml
}

/**
 * Validate XML request bodies.
 *
 * @param  {String}   str
 * @param  {String}   path
 * @param  {String}   methodName
 * @return {Function}
 */
function xmlBodyValidationHandler (str, path, methodName) {
  const libxml = getLibXml()
  let schema

  try {
    schema = libxml.parseXml(str)
  } catch (err) {
    err.message = `Unable to compile XML schema for ${methodName} ${path}: ${err.message}`
    throw err
  }

  return function ospreyXmlBody (req, res, next) {
    if (!req.xml.validate(schema)) {
      return next(createValidationError(formatXmlErrors(req.xml.validationErrors)))
    }

    return next()
  }
}

/**
 * Handle and validate form data requests.
 *
 * @param  {webapi-parser.Payload} body
 * @param  {String}                path
 * @param  {String}                methodName
 * @param  {Object}                options
 * @return {Function}
 */
function formDataBodyHandler (body, path, methodName, options) {
  const Busboy = require('busboy')
  const props = {}
  const sanitizers = {}
  const hasProperties = body.schema && body.schema.properties.length > 0
  if (hasProperties) {
    body.schema.properties.forEach(prop => {
      const name = prop.name.value()
      props[name] = prop
      sanitizers[name] = ramlSanitize.rule(prop)
    })
  }

  return function ospreyFormBodyValidator (req, res, next) {
    if (!hasProperties) {
      return next()
    }
    const busboy = req.form = new Busboy({
      headers: req.headers,
      limits: options.busboyLimits
    })
    const bodyData = {}

    // Override `emit` to provide validations
    busboy.emit = async function emit (type, name, value, a, b, c) {
      function noop () {}
      const close = type === 'field' ? noop : function () {
        value.resume()
      }
      if (type === 'field' || type === 'file') {
        if (!props[name]) {
          return close()
        }

        value = value.readable !== undefined ? value.toString() : value
        let existing = bodyData[name]
        // Collect arrays
        if (existing) {
          existing = Array.isArray(existing) ? existing : [existing]
          value = existing.concat(value)
        }
        value = sanitizers[name] ? sanitizers[name](value) : value
        bodyData[name] = value
      } else if (type === 'finish') {
        // Finish emits twice, but is actually done the second time.
        if (!this._done) {
          return Busboy.prototype.emit.call(this, 'finish')
        }
        const report = await validateWithExtras(body, JSON.stringify(bodyData))
        if (!report.conforms) {
          Busboy.prototype.emit.call(
            this,
            'error',
            createValidationError(formatRamlValidationReport(report, 'form'))
          )
          return
        }
      }

      return Busboy.prototype.emit.apply(this, arguments)
    }
    return next()
  }
}

/**
 * Create a validation error.
 *
 * @param  {String} type
 * @param  {Array}  errors
 * @return {Error}
 */
function createValidationError (errors) {
  const self = createError(
    400, 'Request failed to validate against RAML definition')

  self.requestErrors = errors
  self.ramlValidation = true

  return self
}

/**
 * Discard the request body.
 *
 * @param {Object}   req
 * @param {Object}   res
 * @param {Function} next
 */
function discardBody (req, res, next) {
  debug('%s %s: Discarding request stream', req.method, req.url)

  // TODO(blakeembrey): Make sure this doesn't break in future node versions.
  if (req.readableEnded || req._readableState.ended) {
    return next()
  }

  req.resume()
  req.on('end', next)
  req.on('error', next)
}

/**
 * Enable fast query parameters (E.g. discard them all).
 *
 * @param {Object}   req
 * @param {Object}   res
 * @param {Function} next
 */
function ospreyFastQuery (req, res, next) {
  req.url = parseurl(req).pathname
  req.query = {}

  return next()
}

/**
 * Make RAML validation errors match standard format.
 *
 * @param  {Array} errors
 * @return {Array}
 */
function formatRamlErrors (errors, type) {
  return errors.map(function (error) {
    return {
      type: type,
      dataPath: error.key,
      keyword: error.rule,
      schema: error.attr,
      data: error.value,
      message: `invalid ${type} (${error.rule}, ${error.attr})`
    }
  })
}

function formatRamlValidationReport (report, type) {
  return report.results.map(result => {
    return {
      type: type,
      keyword: result.source.keyword,
      dataPath: report.extras.dataPath,
      data: report.extras.data,
      level: result.level,
      message: `invalid ${type}: ${result.message} (${result.source.keyword})`
    }
  })
}

/**
 * Make XML validation errors match standard format.
 *
 * @param  {Array} errors
 * @return {Array}
 */
function formatXmlErrors (errors) {
  return errors.map(function (error) {
    return {
      type: 'xml',
      message: error.message,
      meta: {
        domain: error.domain,
        code: error.code,
        level: error.level,
        column: error.column,
        line: error.line
      }
    }
  })
}

/**
 * Validates value agains fiels schema adding extra info.
 *
 * @param  {any} field  Anything having field.schema.validate() API.
 * @param  {any} value  Anything to be validated against schema.
 * @return {Promise.<webapi-parser.ValidationReport>}
 */
function validateWithExtras (field, value) {
  return field.schema.validate(value)
    .then(report => {
      report.extras = {
        dataPath: field.name.value(),
        data: value
      }
      return report
    })
}

function tryStringify (val) {
  return typeof val === 'string' ? val : JSON.stringify(val)
}

module.exports = ospreyMethodHandler
