/**
 * Copyright 2015 Markus Weippert <markus@gekmihesg.de>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
**/

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Promise.jsm");

const COMMONJS_URI = 'resource://gre/modules/commonjs';
const { require } = Cu.import(COMMONJS_URI + '/toolkit/require.js', {});
var subprocess = require('sdk/system/child_process/subprocess');

XPCOMUtils.defineLazyModuleGetter(this, "LoginHelper",
				"resource://gre/modules/LoginHelper.jsm");



// all these values are handled, but false values
// are not mapped automatically
const PropertyMap = {
	username: true,
	password: false,
	hostname: true,
	formSubmitURL: true,
	httpRealm: true,
	usernameField: true,
	passwordField: true
};

// vars without "=" are copied from existing environment
const EnvironmentVars = [
	"HOME", "USER", "DISPLAY", "PATH",
	"GPG_AGENT_INFO",
	"PASSWORD_STORE_DIR",
	"PASSWORD_STORE_KEY",
	"PASSWORD_STORE_GIT",
	"PASSWORD_STORE_UMASK",
	"TREE_COLORS=rs:0",
	"TREE_CHARSET=ASCII"
];

const LoginInfo = new Components.Constructor(
		"@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo);

RegExp.escape = function(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	};

function PassManager() {}
PassManager.prototype = {
	classID: Components.ID("{1dadf2b7-f243-41b4-a2f2-e53207f29167}"),
	QueryInterface: XPCOMUtils.generateQI([Ci.nsILoginManagerStorage]),

	_environment: null,
	_propMap: null,
	_passCmd: "",
	_realm: "",
	_fuzzy: false,
	_save_as_username: false,
	_storage_json: null,
	_strip_hostnames: [],

	_cache: {
		defaultLifetime: 300,
		_entries: {},
		get: function (key) {
			if (this._entries[key]) {
				return this._entries[key].value;
			}
			return null;
		},
		add: function (key, value, lifetime) {
			lifetime = (lifetime ? lifetime : this.defaultLifetime) * 1000;
			if (lifetime > 0) {
				let entry = {
					value: value,
					notify: function (timer) {
						this.cache.del(key);
					}
				};
				let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				entry.timer = timer;
				entry.cache = this;
				this._entries[key] = entry;
				timer.initWithCallback(entry, lifetime, Ci.nsITimer.TYPE_ONE_SHOT);
			}
		},
		del: function (key) {
			if (this._entries[key]) {
				this._entries[key].timer.cancel();
				delete this._entries[key];
			}
		},
		clear: function () {
			for (let key in this._entries) {
				this.del(key);
			}
		}
	},

	_stub: function(arguments) {
		throw Error('Not yet implemented: ' + arguments.callee.name + '()');
	},

	_pass: function (args, stdin) {
		let result = null;
		pi = {
			command: this._passCmd,
			arguments: args,
			charset: "UTF-8",
			environment: this._environment,
			done: function (r) { result = r; },
			stdin: stdin,
			mergeStderr: false
		}
		let p = subprocess.call(pi);
		p.wait();
		return result;
	},

	// strip protocol, port and path from URL
	_sanitizeHostname: function (url) {
		return url.replace(/^.*:\/\/([^:\/]+)(?:[:\/].*)?$/, "$1");
	},

	// strip path from URL
	_sanitizeURL: function (url) {
		return url.replace(/^(.*:\/\/[^\/]+)(?:\/.*)?/, "$1");
	},

	_getHostnamePath: function (hostname, all) {
		if (hostname) {
			hostname = this._sanitizeHostname(hostname);
			let options = [this._realm + "/" + hostname];
			if (this._strip_hostnames.length > 0) {
				for each (let sub in this._strip_hostnames) {
					if (hostname.indexOf(sub + ".") == 0) {
						options.unshift(this._realm + "/" +
								hostname.substr(sub.length + 1));
						break;
					}
				}
			}
			return all ? options : options[0];
		}
		return this._realm;
	},

	_loginToStr: function (login) {
		let s = [];
		s.push(login.password);
		for (let prop in this._propMap) {
			if (this._propMap[prop] && login[prop]) {
				s.push(this._propMap[prop][0] + ": " + login[prop]);
			}
		}
		return s.join("\n");
	},

	_strToLogin: function (s) {
		let lines = s.split("\n");
		let re = /^([a-zA-Z]+):\s*(.*)$/;

		// init login with safe values
		let login = new LoginInfo();
		login.username = "";
		login.hostname = "";
		login.password = lines.shift();

		// parse input to object
		let props = {};
		for each (let line in lines) {
			let match = re.exec(line);
			if(match) {
				props[match[1].toLowerCase()] = match[2].trim();
			}
		}

		// map object to login
		for (let prop in this._propMap) {
			if (this._propMap[prop]) {
				for each (let name in this._propMap[prop]) {
					if (props[name]) {
						login[prop] = props[name];
						break;
					}
				}
			}
		}
		return login;
	},
	
	_saveLogin: function (loginPath, login) {
		this._pass(["insert", "-m", "-f", loginPath],
				this._loginToStr(login));

		// update cache with logins clone
		this._cache.add(loginPath, login.clone());
	},

	_loadLogin: function (loginPath) {
		let login = this._cache.get(loginPath);
		if (!login) {
			let result = this._pass(["show", loginPath]);
			if (result.exitCode == 0) {
				login = this._strToLogin(result.stdout);
				if (login) {
					this._cache.add(loginPath, login);
				}
			}
		}
		if (login) {
			// always return a clone!
			// we need the original login cached!
			return login.clone();
		}
		return null;
	},

	// return all paths to logins matching hostname,
	// all logins if hostname is undefined
	_getLoginPaths: function (hostname) {
		let re = /^(.*[|`]+)-- (.*)$/;
		let paths = [];
		for each (let path in this._getHostnamePath(hostname, true)) {
			result = this._pass(["ls", path]);
			if (result.exitCode != 0) {
				continue;
			}
			let lines = result.stdout.split("\n");
			let tree = [];
			let lastIndent = 0;
			let lastNode = null;
			for (let i = 0 ; i < lines.length; i++) {
				let match = re.exec(lines[i]);
				if(match) {
					let indent = match[1].length;
					if (lastNode) {
						if (lastIndent < indent) {
							tree.push(lastNode);
							paths.pop();
						} else if (lastIndent > indent) {
							tree.pop();
						}
					}
					lastIndent = indent;
					lastNode = match[2];
					paths.push(path + "/" +
						tree.concat([lastNode]).join("/"));
				}
			}
		}
		return paths;
	},

	// for fuzzy option
	_autocomplete: function (login, md, path) {
		if (login.hostname) {
			login.hostname = this._sanitizeURL(login.hostname);
		} else if (md.hostname) {
			login.hostname = md.hostname;
		} else {
			var re = new RegExp("^" + RegExp.escape(this._realm) + "\/([^\/]+).*$");
			if ((match = re.exec(path)) !== null) {
				// use hostname from path as fallback
				login.hostname = "https://" + match[1];
			} else {
				login.hostname = "unknown";
			}
		}
		if (login.formSubmitURL) {
			login.formSubmitURL = this._sanitizeURL(login.formSubmitURL);
		} else if (!login.formSubmitURL && !login.httpRealm) {
			if (!md.formSubmitURL && !md.httpRealm) {
				// no info if protocol or HTML login requested,
				// choose HTML since we may return an empty string
				// as wildcard here
				login.formSubmitURL = "";
			} else {
				login.formSubmitURL = md.formSubmitURL;
				login.httpRealm = md.httpRealm;
			}
		}
		if (!login.usernameField) {
			login.usernameField = md.usernameField;
		}
		if (!login.passwordField) {
			login.passwordField = md.passwordField;
		}
		return login;
	},

	_filterLogins: function (matchData) {
		// copy all handled fields from matchData
		let md = {};
		for (let prop in this._propMap) {
			if (prop in matchData) {
				md[prop] = matchData[prop];
			}
		}

		let paths = [];
		let logins = [];

		for each (let path in this._getLoginPaths(md.hostname)) {
			let login = this._loadLogin(path);
			if (login) {
				if (this._fuzzy) {
					this._autocomplete(login, md, path);
				}
				let matches = true;
				for (let prop in md) {
					if (login[prop] != md[prop]) {
						matches = false;
						break;
					}
				}
				if (matches) {
					paths.push(path);
					logins.push(login);
				}
			}
		}
		return [logins, paths];
	},
	
	_isFirefoxAccount: function(hostname, httpRealm) {
		return hostname == "chrome://FirefoxAccounts" &&
				httpRealm == "Firefox Accounts credentials"
	},

	// legacy function called by initialize
	init: function init() {
		// setup environment
		e = Cc["@mozilla.org/process/environment;1"].
							getService(Ci.nsIEnvironment)
		this._environment = [];
		for each (let env in EnvironmentVars) {
			if (env.indexOf("=") > 0) {
				this._environment.push(env);
			} else if (e.exists(env)) {
				this._environment.push(env + "=" + e.get(env));
			}
		}

		this._storage_json = Cc["@mozilla.org/login-manager/storage/json;1"].
				getService(Ci.nsILoginManagerStorage);
		this._storage_json.initialize();

		// load preferences
		let prefObserver = {
			register: function () {
				let prefServ = Cc["@mozilla.org/preferences-service;1"].
						getService(Ci.nsIPrefService);
				this.branch = prefServ.getBranch("extensions.passmanager.");
				this.branch.addObserver("", this, false);

				// initial loading for preferences
				this.observe(this.branch);
			},

			observe: function (subject, topic, data) {
				this.pm._passCmd = subject.getCharPref("pass");
				this.pm._fuzzy = subject.getBoolPref("fuzzy");
				this.pm._save_as_username = subject.getBoolPref("save_as_username");
				this.pm._strip_hostnames = subject.getCharPref("strip_hostnames").
					toLowerCase().split(",");
				this.pm._cache.defaultLifetime = subject.getIntPref("cache");

				// construct realm
				let realm = [subject.getCharPref("realm")];
				if (subject.getBoolPref("realm.append_product")) {
					realm.push(Services.appinfo.name.toLowerCase());
				}
				this.pm._realm = realm.join("/");

				// load property map
				this.pm._propMap = {};
				for (prop in PropertyMap) {
					if (PropertyMap[prop]) {
						this.pm._propMap[prop] =
							subject.getCharPref("map." + prop.toLowerCase()).
								toLowerCase().split(",");
					} else {
						this.pm._propMap[prop] = false;
					}
				}
			}
		};

		prefObserver.pm = this;
		prefObserver.register();
	},

	initialize: function initialize() {
		this.init();
		return Promise.resolve();
	},

	terminate: function terminate() {
		return Promise.resolve();
	},

	addLogin: function addLogin(login) {
		LoginHelper.checkLoginValues(login);
		if (this._isFirefoxAccount(login.hostname, login.httpRealm)) {
			return this._storage_json.addLogin(login);
		}

		let paths = this._getLoginPaths(login.hostname);
		let filename = "passmanager";
		let separator = "";
		let max = 0;
		if (this._save_as_username) {
			let tmp = login.username.replace(/[^a-zA-Z0-9@-_\.]/g, "_").
					replace(/_+/g, "_").replace(/(^_|_$)/g, "");
			if (tmp) {
				filename = tmp;
				separator = "_";
				max = -1;
			}
		}
		let re = new RegExp("\\/" + RegExp.escape(filename) +
				"(?:" + separator + "([0-9]+))?$");
		for each (let path in paths) {
			let matches = re.exec(path);
			if (matches) {
				let num = matches[1] ? Number(matches[1]) : 0;
				if (num > max) {
					max = num;
				}
			}
		}
		let path = this._getHostnamePath(login.hostname);
		filename = filename + (max >= 0 ? separator + (max + 1) : "");
		this._saveLogin(path + "/" + filename, login);
	},

	removeLogin: function removeLogin(login) {
		if (this._isFirefoxAccount(login.hostname, login.httpRealm)) {
			return this._storage_json.removeLogin(login);
		}
		let [logins, paths] = this._filterLogins(login);
		for each (let path in paths) {
			this._pass(["rm", "-f", path]);
			this._cache.del(path);
		}
	},

	modifyLogin: function modifyLogin(oldLogin, newLogin) {
		if (this._isFirefoxAccount(oldLogin.hostname, oldLogin.httpRealm)) {
			return this._storage_json.modifyLogin(oldLogin, newLogin);
		}
		// try to find original login
		let [logins, paths] = this._filterLogins(oldLogin);
		if (logins.length == 0) {
			return;
		}

		if (newLogin instanceof Ci.nsIPropertyBag) {
			// we know what we are supposed to change,
			// so we can load the original login, without
			// autocompletion and only update what's requested
			for each (let path in paths) {
				let changed = false;
				let login = this._loadLogin(path);
				let propEnum = newLogin.enumerator;
				while (propEnum.hasMoreElements()) {
					let prop = propEnum.getNext().QueryInterface(Ci.nsIProperty);
					if (prop.name in this._propMap &&
							login[prop.name] != prop.value) {
						login[prop.name] = prop.value;
						changed = true;
					}
				}
				if (changed) {
					this._saveLogin(path, login);
				}
			}
		} else {
			// newLogin is nsLoginInfo, copy all properties if changed.
			// this case does not seem to happen...
			let changed = false;
			for (let prop in this._propMap) {
				if (newLogin[prop] && oldLogin[prop] != newLogin[prop]) {
					oldLogin[prop] = newLogin[prop];
					changed = true;
				}
			}
			if (changed) {
				for each (let path in paths) {
					this._saveLogin(path, oldLogin);
				}
			}
		}
	},

	getAllLogins: function getAllLogins(count) {
		let [logins, paths] = this._filterLogins({});
		count.value = logins.length;
		return logins;
	},

	removeAllLogins: function removeAllLogins() {
		this._pass(["rm", "-r", "-f", this._realm]);
		this._cache.clear();
	},

	getAllDisabledHosts: function getAllDisabledHosts(count) {
		this._stub(arguments);
	},

	getLoginSavingEnabled: function getLoginSavingEnabled(hostname) {
		return true;
	},

	setLoginSavingEnabled: function setLoginSavingEnabled(hostname, enabled) {
		this._stub(arguments);
	},

	searchLogins: function searchLogins(count, matchData) {
		// extract from nsPropertyBag
		let md = {};
		let propEnum = matchData.enumerator;
		while (propEnum.hasMoreElements()) {
			let prop = propEnum.getNext().QueryInterface(Ci.nsIProperty);
			md[prop.name] = prop.value;
		}
		if (this._isFirefoxAccount(md.hostname, md.httpRealm)) {
			return this._storage_json.searchLogins(count, matchData);
		}

		let [logins, paths] = this._filterLogins(md);
		count.value = logins.length;
		return logins;
	},

	findLogins: function findLogins(count, hostname, formSubmitURL, httpRealm) {
		if (this._isFirefoxAccount(hostname, httpRealm)) {
			return this._storage_json.findLogins(count, hostname,
					formSubmitURL, httpRealm);
		}

		let login= {
			hostname: hostname,
			formSubmitURL: formSubmitURL,
			httpRealm: httpRealm
		};
		let md = {};
		for each (let prop in ["hostname", "formSubmitURL", "httpRealm"]) {
			// empty string means wildcard, null means null
			if (login[prop] != "") {
				md[prop] = login[prop];
			}
		}

		let [logins, paths] = this._filterLogins(md);
		count.value = logins.length;
		return logins;
	},

	// called to check if its worth calling findLogins,
	// which may prompt for master password or pinentry in our case
	countLogins: function countLogins(hostname, formSubmitURL, httpRealm) {
		if (this._isFirefoxAccount(hostname, httpRealm)) {
			return this._storage_json.countLogins(hostname, formSubmitURL,
					httpRealm);
		}
		// only way to check if we have logins without
		// decrypting is by hostname
		let paths = this._getLoginPaths(hostname);
		return paths.length;
	},

	get uiBusy() {
		return false;
	},

	get isLoggedIn() {
		return true;
	}
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([PassManager]);
