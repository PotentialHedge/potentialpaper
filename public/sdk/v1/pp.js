/*
 * PotentialPaper plugin SDK, API version 1. https://ppusercontent.com/sdk/v1/pp.js
 *
 * Load it in your plugin's HTML, before your own script:
 *
 *     <script src="https://ppusercontent.com/sdk/v1/pp.js"></script>
 *
 * It installs `window.pp`, the only bridge between your frame and the page it runs on. Types: pp.d.ts, beside this
 * file. No build step needed. Version 1 only ever grows: check `pp.supports(method)` before using a newer method.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.pp) return;

  var PROTOCOL = 1;
  var THEME_TOKENS_PREFIX = '--pp-';
  var port = null;
  var context = null;
  var nextId = 1;
  var pending = new Map();
  var listeners = new Map();
  var commands = new Map();
  var autoHeight = true;
  var lastHeight = 0;
  var resolveReady;
  var ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  function PluginError(code, message) {
    var error = new Error(message);
    error.name = 'PluginError';
    error.code = code;
    return error;
  }

  function emit(event, params) {
    (listeners.get(event) || []).slice().forEach(function (listener) {
      try {
        listener(params);
      } catch (e) {
        console.error('pp: a listener for ' + event + ' failed', e);
      }
    });
  }

  function on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(listener);
    return function () {
      var list = listeners.get(event) || [];
      var at = list.indexOf(listener);
      if (at !== -1) list.splice(at, 1);
    };
  }

  function applyTheme(theme) {
    if (!theme || !document.documentElement) return;
    var root = document.documentElement;
    Object.keys(theme.tokens || {}).forEach(function (name) {
      root.style.setProperty(THEME_TOKENS_PREFIX + name, theme.tokens[name]);
    });
    root.style.colorScheme = theme.mode;
    root.setAttribute('data-pp-theme', theme.mode);
  }

  function answer(call, result, error) {
    var envelope = error
      ? { v: PROTOCOL, kind: 'error', id: call.id, method: call.method, error: error }
      : { v: PROTOCOL, kind: 'result', id: call.id, method: call.method, result: result === undefined ? null : result };
    port.postMessage(envelope);
  }

  function onPortMessage(event) {
    var m = event.data;
    if (!m || m.v !== PROTOCOL || typeof m.kind !== 'string') return;
    if (m.kind === 'result' || m.kind === 'error') {
      var waiting = pending.get(m.id);
      if (!waiting) return;
      pending.delete(m.id);
      if (m.kind === 'result') waiting.resolve(m.result);
      else waiting.reject(PluginError((m.error && m.error.code) || 'Internal', (m.error && m.error.message) || 'failed'));
      return;
    }
    if (m.kind === 'event') {
      if (m.method === 'theme.change') {
        context.theme = m.params;
        applyTheme(m.params);
      } else if (m.method === 'settings.change') {
        context.settings = m.params;
      } else if (m.method === 'context.change') {
        var settings = context.settings;
        context = m.params;
        context.settings = settings;
        applyTheme(context.theme);
      }
      emit(m.method, m.params);
      return;
    }
    if (m.kind === 'call') {
      if (m.method === 'commands.run') {
        var handler = commands.get(m.params && m.params.command);
        if (!handler) return answer(m, null, { code: 'MethodNotFound', message: 'no handler for that command' });
        Promise.resolve()
          .then(function () {
            return handler(m.params.args);
          })
          .then(
            function (result) {
              answer(m, result);
            },
            function (e) {
              answer(m, null, { code: 'Internal', message: String((e && e.message) || e) });
            },
          );
        return;
      }
      answer(m, null, { code: 'MethodNotFound', message: 'unknown method ' + m.method });
    }
  }

  function call(method, params) {
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending.set(id, { resolve: resolve, reject: reject });
        port.postMessage({ v: PROTOCOL, kind: 'call', id: id, method: method, params: params || {} });
      });
    });
  }

  // The bottom of the body, and of the margin its last child's last child... leaves below it: a margin that collapses
  // through the body is outside its box, and would leave the frame that much short (and scrolling).
  function measure() {
    var body = document.body;
    if (!body) return 0;
    var bottom = body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(body).marginBottom || '0');
    var el = body;
    for (var depth = 0; depth < 20; depth++) {
      var last = null;
      for (var child = el.lastElementChild; child; child = child.previousElementSibling) {
        var position = getComputedStyle(child).position;
        if (position !== 'absolute' && position !== 'fixed' && child.getClientRects().length > 0) {
          last = child;
          break;
        }
      }
      if (!last) break;
      bottom = Math.max(bottom, last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom || '0'));
      el = last;
    }
    return Math.ceil(bottom + window.scrollY);
  }

  function reportHeight() {
    if (!autoHeight || !port) return;
    var height = measure();
    if (height > 0 && Math.abs(height - lastHeight) >= 1) {
      lastHeight = height;
      call('ui.setHeight', { height: height }).catch(function () {});
    }
  }

  function watchHeight() {
    if (typeof ResizeObserver === 'undefined') return;
    var start = function () {
      reportHeight();
      new ResizeObserver(reportHeight).observe(document.body);
    };
    if (document.body) start();
    else window.addEventListener('DOMContentLoaded', start);
    window.addEventListener('load', reportHeight);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'potentialpaper:boot' || data.protocol !== PROTOCOL || !event.ports[0]) return;
    if (port) port.close();
    port = event.ports[0];
    port.onmessage = onPortMessage;
    context = data.context;
    applyTheme(context.theme);
    resolveReady(context);
    watchHeight();
  });

  var page = function (identifier) {
    if (identifier) return identifier;
    if (context && context.page) return context.page.identifier;
    throw PluginError('InvalidParams', 'this frame is on no page; name one');
  };

  window.pp = {
    apiVersion: 1,
    /** Resolves with the frame's context once the host has answered. */
    ready: ready,
    get context() {
      return context;
    },
    supports: function (method) {
      return !!context && context.methods.indexOf(method) !== -1;
    },
    call: call,
    on: on,
    getContext: function () {
      return call('context.get').then(function (next) {
        var settings = context && context.settings;
        context = next;
        if (settings && !next.settings) context.settings = settings;
        return next;
      });
    },
    settings: {
      get: function () {
        return call('settings.get');
      },
      set: function (name, value) {
        return call('settings.set', { name: name, value: value });
      },
      onChange: function (listener) {
        return on('settings.change', listener);
      },
    },
    storage: {
      get: function (key) {
        return call('storage.get', key === undefined ? {} : { key: key });
      },
      set: function (key, value) {
        return call('storage.set', { key: key, value: value === undefined ? null : value });
      },
    },
    page: {
      read: function (identifier) {
        return ready.then(function () {
          return call('page.read', { identifier: page(identifier) });
        });
      },
      members: function (identifier, options) {
        return ready.then(function () {
          var params = Object.assign({ identifier: page(identifier) }, options || {});
          return call('page.members', params);
        });
      },
      resolve: function (identifier) {
        return call('page.resolve', { identifier: identifier });
      },
    },
    scope: {
      scores: function (identifier, venue, field, options) {
        return ready.then(function () {
          var params = { identifier: page(identifier) };
          if (venue) params.venue = venue;
          if (field) params.field = field;
          if (options && options.marks) params.marks = true;
          return call('scope.scores', params);
        });
      },
      papers: function (identifier, options) {
        var opts = options || {};
        var rows = [];
        return ready.then(function () {
          var id = page(identifier);
          function step(after) {
            var params = { identifier: id, limit: opts.chunkSize || 500 };
            if (opts.fields) params.fields = opts.fields;
            if (after) params.after = after;
            return call('scope.papers', params).then(function (chunk) {
              if (opts.onChunk) opts.onChunk(chunk.rows);
              else Array.prototype.push.apply(rows, chunk.rows);
              return chunk.next ? step(chunk.next) : rows;
            });
          }
          return step(opts.after || null);
        });
      },
    },
    reviews: {
      forPaper: function (identifier) {
        return ready.then(function () {
          return call('reviews.forPaper', { identifier: page(identifier) });
        });
      },
    },
    identity: {
      /** Needs `identity`: a short-lived token naming the reader, for your own backend to verify. */
      token: function () {
        return call('identity.token');
      },
      /** `fetch` with the token as `Authorization: Bearer …`, for one of your `network` origins. */
      fetch: function (input, init) {
        return call('identity.token').then(function (identity) {
          var options = Object.assign({}, init || {});
          var headers = new Headers(options.headers || {});
          headers.set('Authorization', 'Bearer ' + identity.token);
          options.headers = headers;
          return fetch(input, options);
        });
      },
    },
    ui: {
      setHeight: function (height) {
        autoHeight = false;
        return call('ui.setHeight', { height: height });
      },
      autoHeight: function (on) {
        autoHeight = on !== false;
        if (autoHeight) reportHeight();
      },
      openUrl: function (url) {
        return call('ui.openUrl', { url: String(url) });
      },
    },
    theme: {
      onChange: function (listener) {
        return on('theme.change', listener);
      },
    },
    commands: {
      register: function (id, handler) {
        commands.set(id, handler);
        return function () {
          if (commands.get(id) === handler) commands.delete(id);
        };
      },
    },
  };
  if (window.parent !== window) window.parent.postMessage({ type: 'potentialpaper:hello', protocol: PROTOCOL }, '*');
})();
