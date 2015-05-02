"use strict";

var nodeURL = require('url');
var querystring = require('querystring');
var _ = require('lodash');
var KindaAbstractRepository = require('kinda-abstract-repository');
var util = require('kinda-util').create();
var httpClient = require('kinda-http-client').create();

var KindaRemoteRepository = KindaAbstractRepository.extend('KindaRemoteRepository', function() {
  var superCreator = this.getCreator();
  this.setCreator(function(name, url, collectionClasses, options) {
    superCreator.apply(this, arguments);
    if (!_.endsWith(url, '/')) url += '/';
    this.baseURL = url;
  });

  // === Authorization ===

  this.getAuthorization = function() {
    return this._authorization;
  };

  this.setAuthorization = function(authorization) {
    this._authorization = authorization;
  };

  this.signInWithCredentials = function *(credentials) {
    if (!credentials) throw new Error('credentials are missing');
    var url = this.baseURL + 'authorizations';
    var params = { method: 'POST', url: url, body: credentials };
    var res = yield httpClient.request(params);
    if (res.statusCode === 403) return;
    if (res.statusCode !== 201) {
      throw new Error('unexpected HTTP status code (' + res.statusCode + ')');
    }
    var authorization = res.body;
    if (!authorization) throw new Error('assertion error (!authorization)');
    this.setAuthorization(authorization);
    return authorization;
  };

  this.signInWithAuthorization = function *(authorization) {
    if (!authorization) throw new Error('authorization is missing');
    var url = this.baseURL + 'authorizations/' + authorization;
    var res = yield httpClient.get(url);
    if (res.statusCode === 403) return false;
    if (res.statusCode !== 204) {
      throw new Error('unexpected HTTP status code (' + res.statusCode + ')');
    }
    this.setAuthorization(authorization);
    return true;
  };

  this.signOut = function *() {
    var authorization = this.getAuthorization();
    if (!authorization) return;
    var url = this.baseURL + 'authorizations/' + authorization;
    var res = yield httpClient.del(url);
    if (res.statusCode !== 204) {
      throw new Error('unexpected HTTP status code (' + res.statusCode + ')');
    }
    this.setAuthorization(undefined);
  };

  this.isSignedIn = function() {
    return !!this.getAuthorization();
  };

  this.authorizationSerializer = function(authorization) { // can be overridden
    var query = { authorization: authorization };
    return { query: query };
  };

  this.writeAuthorization = function(params) {
    var authorization = this.getAuthorization();
    if (!authorization) return;
    authorization = this.authorizationSerializer(authorization);
    _.forOwn(authorization, function(value, key) {
      if (key === 'query') {
        value = util.encodeObject(value);
        var parsedURL = nodeURL.parse(params.url, true);
        _.assign(parsedURL.query, value);
        delete parsedURL.search;
        params.url = nodeURL.format(parsedURL);
      } else {
        throw new Error('invalid serialized authorization key');
      }
    }, this);
  };

  // === Operations ===

  this.getItem = function *(item, options) {
    var collection = item.getCollection();
    var url = this.makeURL(collection, item, undefined, options);
    var params = { method: 'GET', url: url };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode === 204) return; // item not found with errorIfMissing=false
    else if (res.statusCode !== 200) throw this.createError(res);
    var result = res.body;
    var className = result.class;
    if (className === item.getClassName()) {
      item.replaceValue(result.value);
    } else {
      var collection = this.createCollectionFromItemClassName(className);
      item = collection.unserializeItem(result.value);
    }
    return item;
  };

  this.putItem = function *(item, options) {
    var collection = item.getCollection();
    var existingItem = !item.isNew ? item : undefined;
    var url = this.makeURL(collection, existingItem, undefined, options);
    var json = item.serialize();
    var params = { method: item.isNew ? 'POST' : 'PUT', url: url, body: json };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode !== (item.isNew ? 201 : 200)) throw this.createError(res);
    item.replaceValue(res.body.value);
  };

  this.deleteItem = function *(item, options) {
    var collection = item.getCollection();
    var url = this.makeURL(collection, item, undefined, options);
    var params = { method: 'DELETE', url: url };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode !== 204) throw this.createError(res);
  };

  this.getItems = function *(items, options) {
    throw new Error('unimplemented method');
  };

  this.findItems = function *(collection, options) {
    var url = this.makeURL(collection, undefined, undefined, options);
    var params = { method: 'GET', url: url };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode !== 200) throw this.createError(res);
    var results = res.body;
    var cache = {};
    var items = results.map(function(result) {
      var className = result.class;
      var collection = this.createCollectionFromItemClassName(className, cache);
      return collection.unserializeItem(result.value);
    }, this);
    return items;
  };

  this.countItems = function *(collection, options) {
    var url = this.makeURL(collection, undefined, 'count', options);
    var params = { method: 'GET', url: url };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode !== 200) throw this.createError(res);
    return res.body;
  };

  this.forEachItems = function *(collection, options, fn, thisArg) {
    throw new Error('unimplemented method');
  };

  this.findAndDeleteItems = function *(collection, options) {
    var url = this.makeURL(collection, undefined, undefined, options);
    var params = { method: 'DELETE', url: url };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode !== 204) throw this.createError(res);
  };

  this.call = function *(collection, item, method, options, body) {
    var url = this.makeURL(collection, item, method, options);
    var params = {
      method: body == null ? 'GET' : 'POST',
      url: url,
      body: body,
      timeout: 5 * 60 * 1000 // 5 minutes
    };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode === (body == null ? 200 : 201)) {
      return res.body;
    } else if (res.statusCode === 204) {
      return;
    } else {
      throw this.createError(res);
    }
  };

  this.transaction = function *(fn, options) {
    return yield fn(this); // remote transactions are not supported
  };

  this.isInsideTransaction = function() {
    return false;
  };

  // === Helpers ===

  this.makeURL = function(collection, item, method, options) {
    if (!options) options = {};
    var url = this.baseURL;
    var collectionName = collection.getName();
    url += _.kebabCase(collectionName);
    var itemKey = item && item.getPrimaryKeyValue();
    if (itemKey != null) url += '/' + util.encodeValue(itemKey);
    if (method) url += '/' + _.kebabCase(method);
    options = util.encodeObject(options);
    options = querystring.stringify(options);
    if (options) url += '?' + options;
    return url;
  };

  this.createError = function(res) {
    var msg = 'HTTP error: ';
    msg += res.body.error ? res.body.error : 'unknown';
    msg += ' (statusCode=' + res.statusCode + ')';
    var error = new Error(msg);
    error.statusCode = res.statusCode;
    return error;
  };
});

module.exports = KindaRemoteRepository;
