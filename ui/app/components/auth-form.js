/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: BUSL-1.1
 */

import { next } from '@ember/runloop';
import { service } from '@ember/service';
import { match, or } from '@ember/object/computed';
import { dasherize } from '@ember/string';
import Component from '@ember/component';
import { computed } from '@ember/object';
import { allSupportedAuthBackends, supportedAuthBackends } from 'vault/helpers/supported-auth-backends';
import { task } from 'ember-concurrency';
import { waitFor } from '@ember/test-waiters';
import { v4 as uuidv4 } from 'uuid';
import apiErrorMessage from 'vault/utils/api-error-message';

/**
 * @module AuthForm
 * The AuthForm displays the form used to sign users into Vault and passes input data to the Auth::Page component which handles authentication
 *
 * @example
 * <AuthForm @cluster={{model}} @namespace="admin" @selectedAuth="token" @authIsRunning={{this.authenticate.isRunning}}  @performAuth={{this.performAuth}} />
 *
 * @param {string} wrappedToken - Token that can be used to login if added directly to the URL via the "wrapped_token" query param
 * @param {object} cluster - The cluster model which contains information such as cluster id, name and boolean for if the cluster is in standby
 * @param {string} namespace- The currently active namespace.
 * @param {string} selectedAuth - The auth method that is currently selected in the dropdown.
 * @param {function} performAuth - Callback that triggers authenticate task in the parent, backend type (i.e. 'okta') and relevant auth data are passed as args
 * @param {string} error - Error returned by the parent authenticate task, message is generated by the auth service handleError method
 * @param {boolean} authIsRunning - Boolean that relays whether or not the authenticate task is running
 * @param {boolean} delayIsIdle - Boolean that relays whether or not the delayAuthMessageReminder parent task is idle
 */

const DEFAULTS = {
  token: null,
  username: null,
  password: null,
  customPath: null,
};

export default Component.extend(DEFAULTS, {
  router: service(),
  auth: service(),
  flashMessages: service(),
  store: service(),
  csp: service('csp-event'),
  version: service(),
  api: service(),

  // set by query params, passed from parent Auth::Page component
  selectedAuth: null,
  methods: null,
  cluster: null,
  namespace: null,
  wrappedToken: null,
  // internal
  oldNamespace: null,

  authMethods: computed('version.isEnterprise', function () {
    return this.version.isEnterprise ? allSupportedAuthBackends() : supportedAuthBackends();
  }),

  didReceiveAttrs() {
    this._super(...arguments);
    const {
      wrappedToken: token,
      oldWrappedToken: oldToken,
      oldNamespace: oldNS,
      namespace: ns,
      selectedAuth: newMethod,
      oldSelectedAuth: oldMethod,
    } = this;
    next(() => {
      if (!token && (oldNS === null || oldNS !== ns)) {
        this.fetchMethods.perform();
      }
      // don't set any variables if the component is being torn down
      if (this.isDestroyed || this.isDestroying) return;
      this.set('oldNamespace', ns);
      // we only want to trigger this once
      if (token && !oldToken) {
        this.unwrapToken.perform(token);
        this.set('oldWrappedToken', token);
      }
      if (oldMethod && oldMethod !== newMethod) {
        this.resetDefaults();
      }
      this.set('oldSelectedAuth', newMethod);
    });
  },

  didRender() {
    this._super(...arguments);
    // on very narrow viewports the active tab may be overflowed, so we scroll it into view here
    const activeEle = this.element.querySelector('li.is-active');
    if (activeEle) {
      activeEle.scrollIntoView();
    }

    next(() => {
      const firstMethod = this.firstMethod();
      // set `with` to the first method
      if (
        !this.wrappedToken &&
        ((this.fetchMethods.isIdle && firstMethod && !this.selectedAuth) ||
          (this.selectedAuth && !this.selectedAuthBackend))
      ) {
        this.set('selectedAuth', firstMethod);
      }
    });
  },

  firstMethod() {
    const firstMethod = this.methodsToShow[0];
    if (!firstMethod) return;
    // prefer backends with a path over those with a type
    return firstMethod.path || firstMethod.type;
  },

  resetDefaults() {
    this.setProperties(DEFAULTS);
  },

  getAuthBackend(type) {
    const { wrappedToken, methods, selectedAuth, selectedAuthIsPath: keyIsPath } = this;
    const selected = type || selectedAuth;
    if (!methods && !wrappedToken) {
      return {};
    }
    // if type is provided we can ignore path since we are attempting to lookup a specific backend by type
    if (keyIsPath && !type) {
      return methods.find((m) => m.path === selected);
    }
    return this.authMethods.find((m) => m.type === selected);
  },

  selectedAuthIsPath: match('selectedAuth', /\/$/),
  selectedAuthBackend: computed(
    'wrappedToken',
    'methods',
    'methods.[]',
    'selectedAuth',
    'selectedAuthIsPath',
    function () {
      return this.getAuthBackend();
    }
  ),

  providerName: computed('selectedAuthBackend.type', function () {
    if (!this.selectedAuthBackend) {
      return;
    }
    let type = this.selectedAuthBackend.type || 'token';
    type = type.toLowerCase();
    const templateName = dasherize(type);
    return templateName;
  }),

  cspError: computed('csp.connectionViolations.length', function () {
    if (this.csp.connectionViolations.length) {
      return `This is a standby Vault node but can't communicate with the active node via request forwarding. Sign in at the active node to use the Vault UI.`;
    }
    return '';
  }),

  allSupportedMethods: computed('methodsToShow', 'hasMethodsWithPath', 'authMethods', function () {
    const hasMethodsWithPath = this.hasMethodsWithPath;
    const methodsToShow = this.methodsToShow;
    return hasMethodsWithPath ? methodsToShow.concat(this.authMethods) : methodsToShow;
  }),

  hasMethodsWithPath: computed('methodsToShow', function () {
    return this.methodsToShow.isAny('path');
  }),
  methodsToShow: computed('methods', 'authMethods', function () {
    const methods = this.methods || [];
    const shownMethods = methods.filter((m) =>
      this.authMethods.find((b) => b.type.toLowerCase() === m.type.toLowerCase())
    );
    return shownMethods.length ? shownMethods : this.authMethods;
  }),

  unwrapToken: task(
    waitFor(function* (token) {
      // will be using the Token Auth Method, so set it here
      this.set('selectedAuth', 'token');
      try {
        const response = yield this.api.sys.unwrap({}, this.api.buildHeaders({ token }));
        this.set('token', response.auth.clientToken);
        this.send('doSubmit');
      } catch (e) {
        const error = yield apiErrorMessage(e);
        this.set('error', `Token unwrap failed: ${error}`);
      }
    })
  ),

  fetchMethods: task(
    waitFor(function* () {
      const store = this.store;
      try {
        const methods = yield store.findAll('auth-method', {
          adapterOptions: {
            unauthenticated: true,
          },
        });
        this.set(
          'methods',
          methods.map((m) => {
            const method = m.serialize({ includeId: true });
            return {
              ...method,
              mountDescription: method.description,
            };
          })
        );
        // without unloading the records there will be an issue where all methods set to list when unauthenticated will appear for all namespaces
        // if possible, it would be more reliable to add a namespace attr to the model so we could filter against the current namespace rather than unloading all
        next(() => {
          store.unloadAll('auth-method');
        });
      } catch (e) {
        this.set('error', `There was an error fetching Auth Methods: ${e.errors[0]}`);
      }
    })
  ),

  showLoading: or('isLoading', 'authIsRunning', 'fetchMethods.isRunning', 'unwrapToken.isRunning'),

  actions: {
    doSubmit(passedData, event, token) {
      if (event) {
        event.preventDefault();
      }
      if (token) {
        this.set('token', token);
      }
      this.set('error', null);
      // if callback from oidc, jwt, or saml we have a token at this point
      const backend = token ? this.getAuthBackend('token') : this.selectedAuthBackend || {};
      const backendMeta = this.authMethods.find(
        (b) => (b.type || '').toLowerCase() === (backend.type || '').toLowerCase()
      );
      const attributes = (backendMeta || {}).formAttributes || [];
      const data = this.getProperties(...attributes);

      if (passedData) {
        Object.assign(data, passedData);
      }
      if (this.customPath || backend.id) {
        data.path = this.customPath || backend.id;
      }
      // add nonce field for okta backend
      if (backend.type === 'okta') {
        data.nonce = uuidv4();
        // add a default path of okta if it doesn't exist to be used for Okta Number Challenge
        if (!data.path) {
          data.path = 'okta';
        }
      }
      // calls performAuth in login-form.js which initiates the authenticate @task
      return this.performAuth(backend.type, data);
    },
    handleError(e) {
      this.setProperties({
        isLoading: false,
        error: e ? this.auth.handleError(e) : null,
      });
    },
  },
});
