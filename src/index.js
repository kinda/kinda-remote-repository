'use strict';

let nodeURL = require('url');
let _ = require('lodash');
let Qs = require('qs');
let KindaAbstractRepository = require('kinda-abstract-repository');
let util = require('kinda-util').create();
let KindaHTTPClient = require('kinda-http-client');

let KindaRemoteRepository = KindaAbstractRepository.extend('KindaRemoteRepository', function() {
  let superCreator = this.creator;
  this.creator = function(app, options) {
    if (_.isPlainObject(app)) {
      options = app;
      app = undefined;
    }
    if (!options) options = {};
    superCreator.call(this, app, options);

    let httpClient = options.httpClient;
    if (!KindaHTTPClient.isClassOf(httpClient)) {
      httpClient = KindaHTTPClient.create(httpClient);
    }
    this.httpClient = httpClient;

    this.baseURL = options.url;
  };

  this.getRepositoryId = async function() {
    if (this._repositoryId) return this._repositoryId;
    let url = this.makeURL();
    let params = { method: 'GET', url, json: true };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode !== 200) throw this.createError(res);
    let id = res.body.repositoryId;
    this._repositoryId = id;
    return id;
  };

  this.transaction = async function(fn) {
    return await fn(this); // remote transactions are not supported
  };

  this.isInsideTransaction = false;

  // === Authorization ===

  Object.defineProperty(this, 'authorization', {
    get() {
      return this._authorization;
    },
    set(authorization) {
      this._authorization = authorization;
    }
  });

  this.signInWithCredentials = async function(credentials) {
    if (!credentials) throw new Error('credentials are missing');
    let url = this.makeURL('authorizations');
    let params = { method: 'POST', url, body: credentials, json: true };
    let res = await this.httpClient.request(params);
    if (res.statusCode === 403) return undefined;
    if (res.statusCode !== 201) {
      throw new Error(`unexpected HTTP status code (${res.statusCode})`);
    }
    let authorization = res.body;
    if (!authorization) throw new Error('assertion error (!authorization)');
    this.authorization = authorization;
    return authorization;
  };

  this.signInWithAuthorization = async function(authorization) {
    if (!authorization) throw new Error('authorization is missing');
    let url = this.makeURL('authorizations', authorization);
    let res = await this.httpClient.get({ url, json: true });
    if (res.statusCode === 403) return false;
    if (res.statusCode !== 204) {
      throw new Error(`unexpected HTTP status code (${res.statusCode})`);
    }
    this.authorization = authorization;
    return true;
  };

  this.signOut = async function() {
    if (!this.isSignedIn) return;
    let url = this.makeURL('authorizations', this.authorization);
    let res = await this.httpClient.del({ url, json: true });
    if (res.statusCode !== 204) {
      throw new Error(`unexpected HTTP status code (${res.statusCode})`);
    }
    this.authorization = undefined;
  };

  Object.defineProperty(this, 'isSignedIn', {
    get() {
      return !!this.authorization;
    }
  });

  this.authorizationSerializer = function(authorization) { // can be overridden
    let query = { authorization };
    return { query };
  };

  this.writeAuthorization = function(params) {
    let authorization = this.authorization;
    if (!authorization) return;
    authorization = this.authorizationSerializer(authorization);
    _.forOwn(authorization, function(value, key) {
      if (key === 'query') {
        value = util.encodeValue(value);
        let parsedURL = nodeURL.parse(params.url, true);
        _.assign(parsedURL.query, value);
        delete parsedURL.search;
        params.url = nodeURL.format(parsedURL);
      } else {
        throw new Error('invalid serialized authorization key');
      }
    }, this);
  };

  // === Operations ===

  this.getItem = async function(item, options) {
    let collection = item.collection;
    let url = this.makeURL(collection, item, undefined, options);
    let params = { method: 'GET', url, json: true };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode === 204) return undefined; // item not found with errorIfMissing=false
    else if (res.statusCode !== 200) throw this.createError(res);
    let result = res.body;
    let className = result.class;
    if (className === item.class.name) {
      item.replaceValue(result.value);
    } else {
      let realCollection = this.createCollectionFromItemClassName(className);
      item = realCollection.unserializeItem(result.value);
    }
    return item;
  };

  this.putItem = async function(item, options) {
    let collection = item.collection;
    let existingItem = !item.isNew ? item : undefined;
    let url = this.makeURL(collection, existingItem, undefined, options);
    let json = item.serialize();
    let params = { method: item.isNew ? 'POST' : 'PUT', url, body: json, json: true };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode !== (item.isNew ? 201 : 200)) throw this.createError(res);
    item.replaceValue(res.body.value);
    await this.emit('didPutItem', item, options);
  };

  this.deleteItem = async function(item, options) {
    let collection = item.collection;
    let url = this.makeURL(collection, item, undefined, options);
    let params = { method: 'DELETE', url, json: true };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode !== 200) throw this.createError(res);
    let hasBeenDeleted = res.body;
    if (hasBeenDeleted) await this.emit('didDeleteItem', item, options);
    return hasBeenDeleted;
  };

  this.getItems = async function(items, options) {
    if (!items.length) return [];
    // we suppose that every items are part of the same collection:
    let collection = items[0].collection;
    let keys = _.pluck(items, 'primaryKeyValue');
    let url = this.makeURL(collection, undefined, 'getItems', options);
    let params = { method: 'POST', url, body: keys, json: true };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode !== 201) throw this.createError(res);
    let results = res.body;
    let cache = {};
    items = results.map(result => {
      // TODO: like getItem(), try to reuse the passed items instead of
      // build new one
      let className = result.class;
      let realCollection = this.createCollectionFromItemClassName(className, cache);
      return realCollection.unserializeItem(result.value);
    });
    return items;
  };

  this.findItems = async function(collection, options) {
    let url = this.makeURL(collection, undefined, undefined, options);
    let params = { method: 'GET', url, json: true };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode !== 200) throw this.createError(res);
    let results = res.body;
    let cache = {};
    let items = results.map(result => {
      let className = result.class;
      let realCollection = this.createCollectionFromItemClassName(className, cache);
      return realCollection.unserializeItem(result.value);
    });
    return items;
  };

  this.countItems = async function(collection, options) {
    let url = this.makeURL(collection, undefined, 'count', options);
    let params = { method: 'GET', url, json: true };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode !== 200) throw this.createError(res);
    return res.body;
  };

  this.forEachItems = async function(collection, options, fn, thisArg) { // eslint-disable-line no-unused-vars
    throw new Error('unimplemented method');
  };

  this.findAndDeleteItems = async function(collection, options) {
    let url = this.makeURL(collection, undefined, undefined, options);
    let params = {
      method: 'DELETE',
      url,
      json: true,
      timeout: 5 * 60 * 1000 // 5 minutes
    };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode !== 200) throw this.createError(res);
    return res.body;
  };

  this.call = async function(collection, item, method, options, body) {
    let url = this.makeURL(collection, item, method, options);
    let params = {
      method: body == null ? 'GET' : 'POST',
      url,
      body,
      json: true,
      timeout: 5 * 60 * 1000 // 5 minutes
    };
    this.writeAuthorization(params);
    let res = await this.httpClient.request(params);
    if (res.statusCode === (body == null ? 200 : 201)) {
      return res.body;
    } else if (res.statusCode === 204) {
      return undefined;
    } else {
      throw this.createError(res);
    }
  };

  // === Helpers ===

  this.makeURL = function(collection, item, method, options) {
    if (!options) options = {};

    let url = this.baseURL;
    if (_.endsWith(url, '/')) url = url.slice(0, -1);

    if (collection) {
      if (!_.isString(collection)) collection = collection.name;
      url += '/' + _.kebabCase(collection);
    }

    if (item) {
      if (!_.isString(item)) item = item.primaryKeyValue;
      if (item != null) url += '/' + util.encodeValue(item);
    }

    if (method) {
      url += '/' + _.kebabCase(method);
    }

    options = util.encodeValue(options);
    options = Qs.stringify(options);
    if (options) {
      url += '?' + options;
    }

    return url;
  };

  this.createError = function(res) {
    let msg = res.body.message ? res.body.message : 'Remote Error';
    let err = new Error(msg);
    err.statusCode = res.statusCode;
    if (res.body.type) err.type = res.body.type;
    return err;
  };
});

module.exports = KindaRemoteRepository;
