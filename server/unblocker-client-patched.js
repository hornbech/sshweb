// Patched copy of node_modules/unblocker/lib/client/unblocker-client.js.
// Reason: the upstream initFetch does `resource.url = fixUrl(...)`, but Request.url
// is a read-only getter — this throws TypeError in strict mode whenever a SPA
// calls `fetch(new Request(...))`. That silently breaks multi-step login flows.
// The fix reconstructs the Request with a rewritten URL.
export const PATCHED_CLIENT_JS = `(function (global) {
  "use strict";

  function fixUrl(urlStr, config, location) {
    var currentRemoteHref;
    if (location.pathname.substr(0, config.prefix.length) === config.prefix) {
      currentRemoteHref =
        location.pathname.substr(config.prefix.length) +
        location.search +
        location.hash;
    } else {
      currentRemoteHref = config.url;
    }

    if (urlStr.substr(0, config.prefix.length) === config.prefix) {
      return urlStr;
    }

    var url = new URL(urlStr, currentRemoteHref);

    if (
      url.origin === location.origin &&
      url.pathname.substr(0, config.prefix.length) === config.prefix
    ) {
      return urlStr;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return urlStr;
    }

    if (url.hostname === location.hostname) {
      var currentRemoteUrl = new URL(currentRemoteHref);
      url.host = currentRemoteUrl.host;
      url.protocol = currentRemoteUrl.protocol;
    }
    return config.prefix + url.href;
  }

  function initXMLHttpRequest(config, window) {
    if (!window.XMLHttpRequest) return;
    var _XMLHttpRequest = window.XMLHttpRequest;

    window.XMLHttpRequest = function (opts) {
      var xhr = new _XMLHttpRequest(opts);
      var _open = xhr.open;
      xhr.open = function () {
        var args = Array.prototype.slice.call(arguments);
        if (args[1] != null) args[1] = fixUrl(String(args[1]), config, location);
        return _open.apply(xhr, args);
      };
      return xhr;
    };
  }

  function initFetch(config, window) {
    if (!window.fetch) return;
    var _fetch = window.fetch;
    var _Request = window.Request;

    window.fetch = function (resource, init) {
      try {
        if (_Request && resource instanceof _Request) {
          // Request.url is read-only — reconstruct with a rewritten URL.
          // new Request(url, existingRequest) copies method/headers/body/etc.
          // Use an absolute URL so the Request constructor doesn't need a base.
          var fixed = fixUrl(resource.url, config, location);
          if (fixed !== resource.url) {
            var absolute = fixed.charAt(0) === "/" ? location.origin + fixed : fixed;
            resource = new _Request(absolute, resource);
          }
        } else if (typeof resource === "string") {
          resource = fixUrl(resource, config, location);
        } else if (resource != null) {
          // URL object or other stringifiable
          resource = fixUrl(resource.toString(), config, location);
        }
      } catch (e) {
        console.error("[unblocker-client] fetch url rewrite failed", e);
      }
      return _fetch.call(window, resource, init);
    };
  }

  function initCreateElement(config, window) {
    if (!window.document || !window.document.createElement) return;
    var _createElement = window.document.createElement;

    window.document.createElement = function (tagName, options) {
      if (tagName.toLowerCase() === "iframe") {
        initAppendBodyIframe(config, window);
      }
      var element = _createElement.call(window.document, tagName, options);
      Object.defineProperty(element, "src", {
        set: function (src) {
          delete element.src;
          element.src = fixUrl(src, config, location);
        },
        configurable: true,
      });
      Object.defineProperty(element, "href", {
        set: function (href) {
          delete element.href;
          element.href = fixUrl(href, config, location);
        },
        configurable: true,
      });
      return element;
    };
  }

  function initAppendBodyIframe(config, window) {
    if (
      !window.document ||
      !window.document.body ||
      !window.document.body.appendChild ||
      window.document.body.unblockerIframeAppendListenerInstalled
    ) {
      return;
    }

    var _appendChild = window.document.body.appendChild;

    window.document.body.appendChild = function (element) {
      var ret = _appendChild.call(window.document.body, element);
      if (
        element.tagName &&
        element.tagName.toLowerCase() === "iframe" &&
        element.src === "about:blank" &&
        element.contentWindow
      ) {
        initForWindow(config, element.contentWindow);
      }
      return ret;
    };
    window.document.body.unblockerIframeAppendListenerInstalled = true;
  }

  function initWebSockets(config, window) {
    if (!window.WebSocket) return;
    var _WebSocket = window.WebSocket;
    var prefix = config.prefix;
    var proxyHost = location.host;
    var isSecure = location.protocol === "https";
    var target = location.pathname.substr(prefix.length);
    var targetURL = new URL(target);

    var reWsUrl = /^ws(s?):\\/\\/([^/]+)($|\\/.*)/;

    window.WebSocket = function (url, protocols) {
      var parsedUrl = url.match(reWsUrl);
      if (parsedUrl) {
        var wsSecure = parsedUrl[1];
        var wsProto = isSecure ? "ws" + wsSecure + "://" : "ws://";
        var wsHost = parsedUrl[2];
        if (wsHost === location.host || wsHost === location.hostname) {
          wsHost = targetURL.host;
        }
        var wsPath = parsedUrl[3];
        return new _WebSocket(
          wsProto +
            proxyHost +
            prefix +
            "http" +
            wsSecure +
            "://" +
            wsHost +
            wsPath
        );
      }
      return new _WebSocket(url, protocols);
    };
  }

  function initPushState(config, window) {
    if (!window.history || !window.history.pushState) return;

    var _pushState = window.history.pushState;
    window.history.pushState = function (state, title, url) {
      if (url) {
        url = fixUrl(url, config, location);
        config.url = new URL(url, config.url);
        return _pushState.call(history, state, title, url);
      }
    };

    if (!window.history.replaceState) return;
    var _replaceState = window.history.replaceState;
    window.history.replaceState = function (state, title, url) {
      if (url) {
        url = fixUrl(url, config, location);
        config.url = new URL(url, config.url);
        return _replaceState.call(history, state, title, url);
      }
    };
  }

  function initForWindow(config, window) {
    initXMLHttpRequest(config, window);
    initFetch(config, window);
    initCreateElement(config, window);
    initAppendBodyIframe(config, window);
    initWebSockets(config, window);
    initPushState(config, window);
    if (window === global) {
      delete global.unblockerInit;
    }
  }

  if (typeof module === "undefined") {
    global.unblockerInit = initForWindow;
  } else {
    module.exports = {
      initForWindow: initForWindow,
      fixUrl: fixUrl,
    };
  }
})(this);
`
