"use strict";

var nodeURL = require('url');
var querystring = require('querystring');
var _ = require('lodash');
var KindaObject = require('kinda-object');
var util = require('kinda-util').create();
var httpClient = require('kinda-http-client').create();

var KindaRemoteRepository = KindaObject.extend('KindaRemoteRepository', function() {
  this.setCreator(function(url) {
    if (!url) throw new Error('url is missing');
    if (!_.endsWith(url, '/')) url += '/';
    this.baseURL = url;
  });

  this.authorizationSerializer = function(authorization) { // can be overridden
    var query = { authorization: authorization };
    return { query: query };
  };

  this.getAuthorization = function() {
    return this._authorization;
  };

  this.setAuthorization = function(authorization) {
    this._authorization = authorization;
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

  this.getItem = function *(item, options) {
    var collection = item.getCollection();
    var url = this.makeURL(collection, item, undefined, options);
    var params = { method: 'GET', url: url };
    this.writeAuthorization(params);
    var res = yield httpClient.request(params);
    if (res.statusCode === 204) return; // item not found with errorIfMissing=false
    else if (res.statusCode !== 200) throw this.createError(res);
    item.replaceValue(res.body);
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
    item.replaceValue(res.body);
  };

  this.deleteItem = function *(item, options) {
    var collection = item.getCollection();
    var url = this.makeURL(collection, item, undefined, options);
    var params = {
      method: 'DELETE',
      url: url,
      json: false // Avoid a bug in browser-request
    };
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
    var items = res.body;
    items = items.map(function(item) {
      return collection.unserializeItem(item);
    });
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

  this.call = function *(collection, item, method, options, body) {
    var url = this.makeURL(collection, item, method, options);
    var params = {
      method: body == null ? 'GET' : 'POST',
      url: url,
      body: body
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

  this.makeURL = function(collection, item, action, query) {
    if (!query) query = {};
    var url = this.baseURL;
    var collectionName = collection.getName();
    url += _.kebabCase(collectionName);
    var itemKey = item && item.getPrimaryKeyValue();
    if (itemKey != null) url += '/' + util.encodeValue(itemKey);
    if (action) url += '/' + action;
    query = util.encodeObject(query);
    query = querystring.stringify(query);
    if (query) url += '?' + query;
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
