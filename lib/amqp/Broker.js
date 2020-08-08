var debug = require('debug')('rascal:Broker');
var format = require('util').format;
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var _ = require('lodash');
var async = require('async');
var tasks = require('./tasks');
var configure = require('../config/configure');
var validate = require('../config/validate');
var fqn = require('../config/fqn');
var preflight = async.compose(validate, configure);
var stub = require('../counters/stub');
var inMemory = require('../counters/inMemory');
var inMemoryCluster = require('../counters/inMemoryCluster').worker;
var setTimeoutUnref = require('../utils/setTimeoutUnref');
var maxInterval = 2147483647;

module.exports = {
  create: function create(config, components, next) {
    if (arguments.length === 2) return create(config, {}, arguments[1]);
    preflight(_.cloneDeep(config), function(err, config) {
      if (err) return next(err);
      new Broker(config, components)._init(next);
    });
  },
};

inherits(Broker, EventEmitter);

function Broker(config, components) {

  var self = this;
  var vhosts = {};
  var publications = {};
  var subscriptions = {};
  var sessions = [];
  var init = async.compose(tasks.initShovels, tasks.initSubscriptions, tasks.initPublications, tasks.initCounters, tasks.initVhosts);
  var nukeVhost = async.compose(tasks.deleteVhost, tasks.shutdownVhost, tasks.nukeVhost);
  var purgeVhost = tasks.purgeVhost;
  var shutdownVhost = tasks.shutdownVhost;
  var bounceVhost = tasks.bounceVhost;
  var counters = _.defaults({}, components.counters, { stub: stub, inMemory: inMemory, inMemoryCluster: inMemoryCluster });

  this.config = config;
  this.promises = false;

  this._init = function(next) {
    debug('Initialising broker');
    vhosts = {};
    publications = {};
    subscriptions = {};
    sessions = [];
    init(config, { broker: self, components: { counters: counters } }, function(err, config, ctx) {
      self.keepActive = setInterval(_.noop, maxInterval);
      setImmediate(function() {
        next(err, self);
      });
    });
  };

  this.connect = function(name, next) {
    if (!vhosts[name]) return next(new Error(format('Unknown vhost: %s', name)));
    vhosts[name].connect(next);
  };

  this.nuke = function(next) {
    debug('Nuking broker');
    self.unsubscribeAll(function(err) {
      if (err) return next(err);
      async.eachSeries(_.values(vhosts), function(vhost, callback) {
        nukeVhost(config, { vhost: vhost }, callback);
      }, function(err) {
        if (err) return next(err);
        vhosts = publications = subscriptions = {};
        debug('Finished nuking broker');
        next();
      });
    });
  };

  this.purge = function(next) {
    debug('Purging all queues in all vhosts');
    async.eachSeries(_.values(vhosts), function(vhost, callback) {
      purgeVhost(config, { vhost: vhost }, callback);
    }, function(err) {
      if (err) return next(err);
      debug('Finished purging all queues in all vhosts');
      next();
    });
  };

  this.shutdown = function(next) {
    debug('Shutting down broker');
    self.unsubscribeAll(function(err) {
      if (err) return next(err);
      async.eachSeries(_.values(vhosts), function(vhost, callback) {
        shutdownVhost(config, { vhost: vhost }, callback);
      }, function(err) {
        if (err) return next(err);
        clearInterval(self.keepActive);
        debug('Finished shutting down broker');
        next();
      });
    });
  };

  this.bounce = function(next) {
    debug('Bouncing broker');
    self.unsubscribeAll(function(err) {
      if (err) return next(err);
      async.eachSeries(_.values(vhosts), function(vhost, callback) {
        bounceVhost(config, { vhost: vhost }, callback);
      }, function(err) {
        if (err) return next(err);
        debug('Finished bouncing broker');
        next();
      });
    });
  };

  this.publish = function(name, message, overrides, next) {
    if (arguments.length === 3) return self.publish(name, message, {}, arguments[2]);
    if (_.isString(overrides)) return self.publish(name, message, { routingKey: overrides }, next);
    if (!publications[name]) return next(new Error(format('Unknown publication: %s', name)));
    publications[name].publish(message, overrides, next);
  };

  this.forward = function(name, message, overrides, next) {
    if (arguments.length === 3) return self.forward(name, message, {}, arguments[2]);
    if (_.isString(overrides)) return self.forward(name, message, { routingKey: overrides }, next);
    if (!config.publications[name]) return next(new Error(format('Unknown publication: %s', name)));
    publications[name].forward(message, overrides, next);
  };

  this.subscribe = function(name, overrides, next) {
    if (arguments.length === 2) return self.subscribe(name, {}, arguments[1]);
    if (!subscriptions[name]) return next(new Error(format('Unknown subscription: %s', name)));
    subscriptions[name].subscribe(overrides, function(err, session) {
      if (err) return next(err);
      sessions.push(session);
      next(null, session);
    });
  };

  this.subscribeAll = function(filter, next) {
    if (arguments.length === 1) return self.subscribeAll(function() { return true; }, arguments[0]);
    var filteredSubscriptions = _.chain(config.subscriptions).values().filter(filter).value();
    async.mapSeries(filteredSubscriptions, function(subscriptionConfig, cb) {
      self.subscribe(subscriptionConfig.name, function(err, subscription) {
        if (err) return cb(err);
        cb(null, subscription);
      });
    }, next);
  };

  this.unsubscribeAll = function(next) {
    var timeout = getMaxDeferCloseChannelTimeout();
    async.eachSeries(sessions.slice(), function(session, cb) {
      sessions.shift();
      session.cancel(cb);
    }, function(err) {
      if (err) return next(err);
      debug('Waiting %dms for all subscriber channels to close', timeout);
      setTimeoutUnref(next, timeout);
    });
  };

  this.getConnections = function() {
    return Object.keys(vhosts).map(function(name) {
      return vhosts[name].getConnectionDetails();
    });
  };

  this.getFullyQualifiedName = this.qualify = function(vhost, name) {
    return fqn.qualify(name, config.vhosts[vhost].namespace);
  };

  this._addVhost = function(vhost) {
    vhosts[vhost.name] = vhost;
  };

  this._addPublication = function(publication) {
    publications[publication.name] = publication;
  };

  this._addSubscription = function(subscription) {
    subscriptions[subscription.name] = subscription;
  };

  function getMaxDeferCloseChannelTimeout() {
    return sessions.reduce(function(value, session) {
      return session._maxDeferCloseChannel(value);
    }, 0);
  }
}
