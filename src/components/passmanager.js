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
Cu.import("chrome://passmanager/content/subprocess/subprocess.jsm");

const PropertyMap = {
	username: true,
	password: false,
	hostname: true,
	formSubmitURL: true,
	httpRealm: true,
	usernameField: true,
	passwordField: true
};

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


function PassManager() {}
PassManager.prototype = {
	classID: Components.ID("{1dadf2b7-f243-41b4-a2f2-e53207f29167}"),
	QueryInterface: XPCOMUtils.generateQI([Ci.nsILoginManagerStorage]),
	_uiBusy: false,
	_environment: null,
	_pass: null,
	_realm: null,
	_fuzzy: false,
	_cache: {
		defaultLifetime: 300,
		_entries: new Array(),
		get: function (key) {
			if (this._entries[key]) {
				return this._entries[key].value;
			}
			return null;
		},
		add: function (key, value, lifetime) {
			lifetime = (lifetime ? lifetime : this.defaultLifetime) * 1000;
			if (lifetime > 0) {
				var entry = {
					value: value,
					notify: function (timer) {
						this.cache.del(key);
					}
				};
				var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
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


	stub: function(arguments) {
		throw Error('Not yet implemented: ' + arguments.callee.name + '()');
	},

	pass: function (args, stdin) {
		var result = null;
		pi = {
			command: this._pass,
			arguments: args,
			charset: "UTF-8",
			environment: this._environment,
			done: function (r) { result = r; },
			stdin: stdin,
			mergeStderr: false
		}
		var p = subprocess.call(pi);
		this._uiBusy = true;
		p.wait();
		this._uiBusy = false;
		return result;
	},

	sanitizeHostname: function (hostname) {
		return hostname.replace(/^.*:\/\/([^:\/]+)(?:[:\/].*)?$/, "$1");
	},

	getHostnamePath: function (hostname) {
		if (hostname) {
			return this._realm + "/" +
				this.sanitizeHostname(hostname);
		}
		return this._realm;
	},

	loginToStr: function (login) {
		var s = new Array();
		s.push(login.password);
		for (let prop in PropertyMap) {
			if (PropertyMap[prop] && login[prop]) {
				s.push(PropertyMap[prop][0] + ": " + login[prop]);
			}
		}
		return s.join("\n");
	},

	strToLogin: function (s) {
		var login = new LoginInfo();
		var lines = s.split("\n");
		login.username = "";
		login.hostname = "";
		login.password = lines.shift();
		var re = /^([a-zA-Z]+):\s*(.*)$/;
		var props = new Array();
		for(let i = 0 ; i < lines.length; i++) {
			let match = re.exec(lines[i]);
			if(match) {
				props[match[1].toLowerCase()] = match[2].trim();
			}
		}
		for (let prop in PropertyMap) {
			if (PropertyMap[prop]) {
				for (let i = 0; i < PropertyMap[prop].length; i ++) {
					if (props[PropertyMap[prop][i]]) {
						login[prop] = props[PropertyMap[prop][i]];
						break;
					}
				}
			}
		}
		return login;
	},
	
	saveLogin: function (loginPath, login) {
		this.pass(["insert", "-m", "-f", loginPath],
				this.loginToStr(login));
		this._cache.add(loginPath, login.clone());
	},

	loadLogin: function (loginPath, autocomplete) {
		var login = this._cache.get(loginPath);
		if (!login) {
			var result = this.pass(["show", loginPath]);
			if (result.exitCode == 0) {
				login = this.strToLogin(result.stdout);
				if (login) {
					this._cache.add(loginPath, login);
				}
			}
		}
		if (login) {
			if (autocomplete) {
				return autocomplete(login.clone());
			}
			return login.clone();
		}
		return null;
	},

	getLoginPaths: function (hostname, filter, load, autocomplete) {
		var path = this.getHostnamePath(hostname);
		result = this.pass(["ls", path]);
		if (result.exitCode != 0) {
			return new Array();
		}
		var lines = result.stdout.split("\n");
		var re = /^(.*[|`]+)-- (.*)$/;
		var logins = new Array();
		var tree = new Array();
		var lastIndent = 0;
		var lastNode = null;
		var lastSaved = false;
		for(let i = 0 ; i < lines.length; i++) {
			let match = re.exec(lines[i]);
			if(match) {
				let indent = match[1].length;
				if (lastNode) {
					if (lastIndent < indent) {
						tree.push(lastNode);
						if (lastSaved) {
							logins.pop();
						}
					} else if (lastIndent > indent) {
						tree.pop();
					}
				}
				lastIndent = indent;
				lastNode = match[2];
				lastSaved = true;
				let loginPath = path + "/" +
					tree.concat([match[2]]).join("/");
				let login = null;
				if (filter || load) {
					login = this.loadLogin(loginPath, autocomplete);
					lastSaved = login && (!filter || filter(login));
				}
				if (lastSaved) {
					logins.push(load ? login : loginPath);
				}
			}
		}
		return logins;
	},

	filterLogins: function (load, hostname, formSubmitURL, httpRealm) {
		var filter = null;
		var autocomplete = null;
		if (hostname instanceof Ci.nsILoginInfo) {
			var oldLogin = hostname;
			formSubmitURL = oldLogin.formSubmitURL;
			httpRealm = oldLogin.httpRealm;
			hostname = oldLogin.hostname;
			filter = function (login) {
				return this._fuzzy ?
					oldLogin.matches(login) :
					oldLogin.equals(login);
			};
		} else if (formSubmitURL != null || httpRealm != null) {
			filter = function (login) {
				return login.hostname == hostname &&
					(formSubmitURL == null ||
					 	(formSubmitURL == "" ?
						 	login.formSubmitURL || this._fuzzy :
							login.formSubmitURL == formSubmitURL)) &&
					(httpRealm == null ||
					 	(httpRealm == "" ?
						 	login.httpRealmi || this._fuzzy :
							login.httpRealm == httpRealm))
			};
		}
		if (this._fuzzy) {
			autocomplete = function (login) {
				var cleanURL = function (url) {
					return url.replace(/^(.*:\/\/[^\/]+)(?:\/.*)?/, "$1");
				}
				if (login.hostname) {
					login.hostname = cleanURL(login.hostname);
				} else {
					login.hostname = hostname ? hostname : "unknown";
				}
				if (!login.formSubmitURL && !login.httpRealm) {
					if (!formSubmitURL && httpRealm == null) {
						login.formSubmitURL = login.hostname;
					} else {
						login.formSubmitURL = formSubmitURL;
						login.httpRealm = httpRealm;
					}
				} else if (login.formSubmitURL) {
					login.formSubmitURL = cleanURL(login.formSubmitURL);
				}
				return login;
			};
		}
		return this.getLoginPaths(hostname, filter, load, autocomplete);
	},

	init: function () {
		e = Cc["@mozilla.org/process/environment;1"].
							getService(Ci.nsIEnvironment)
		this._environment = new Array();
		for (let i = 0; i < EnvironmentVars.length; i++) {
			if (EnvironmentVars[i].indexOf("=") > 0) {
				this._environment.push(EnvironmentVars[i]);
			} else if (e.exists(EnvironmentVars[i])) {
				this._environment.push(EnvironmentVars[i] + "=" +
						e.get(EnvironmentVars[i]));
			}
		}

		var prefObserver = {
			register: function () {
				var prefServ = Cc["@mozilla.org/preferences-service;1"].
						getService(Ci.nsIPrefService);
				this.branch = prefServ.getBranch("extensions.passmanager.");
				this.branch.addObserver("", this, false);
				this.observe(this.branch);
			},
			observe: function (subject, topic, data) {
				this.pm._pass = subject.getCharPref("pass");
				this.pm._fuzzy = subject.getBoolPref("fuzzy");
				this.pm._cache.defaultLifetime = subject.getIntPref("cache");
				var realm = new Array(subject.getCharPref("realm"));
				if (subject.getBoolPref("realm.append_product")) {
					realm.push(Services.appinfo.name.toLowerCase());
				}
				this.pm._realm = realm.join("/");
				for (prop in PropertyMap) {
					if (PropertyMap[prop]) {
						PropertyMap[prop] =
							subject.getCharPref("map." + prop.toLowerCase()).
								toLowerCase().split(",");
					}
				}
				subject.addObserver("", this, false);
			}
		};
		prefObserver.pm = this;
		prefObserver.register();
	},

	initialize: function () {
		this.init();
		return Promise.resolve();
	},

	terminate: function () {
		return Promise.resolve();
	},

	addLogin: function addLogin(login) {
		var logins = this.filterLogins(false, login.hostname);
		var path = this.getHostnamePath(login.hostname);
		var re = /\/passmanager([0-9]+)$/;
		var max = 0;
		for (let i = 0; i < logins.length; i ++) {
			let matches = re.exec(logins[i]);
			if (matches && matches[1] > max) {
				max = Number(matches[1]);
			}
		}
		this.saveLogin(path + "/passmanager" + (max + 1), login);
	},

	removeLogin: function removeLogin(login) {
		var logins = this.filterLogins(false, login);
		for (let i = 0; i < logins.length; i++) {
			let loginPath = logins[i];
			this.pass(["rm", "-f", loginPath]);
			this._cache.del(loginPath);
		}
	},

	modifyLogin: function modifyLogin(oldLogin, newLogin) {
		var logins = this.filterLogins(false, oldLogin);
		if (logins.length == 0) {
			return;
		}
		if (newLogin instanceof Ci.nsIPropertyBag) {
			let propEnum = newLogin.enumerator;
			for (let i = 0; i < logins.length; i++) {
				let login = this.loadLogin(logins[i]);
				let changed = false;
				while (propEnum.hasMoreElements()) {
					let prop = propEnum.getNext().QueryInterface(Ci.nsIProperty);
					if (prop.name in PropertyMap &&
							login[prop.name] != prop.value) {
						login[prop.name] = prop.value;
						changed = true;
					}
				}
				if (changed) {
					this.saveLogin(logins[i], login);
				}
			}
		} else {
			let changed = false;
			for (let prop in PropertyMap) {
				if (newLogin[prop] && oldLogin[prop] != newLogin[prop]) {
					oldLogin[prop] = newLogin[prop];
					changed = true;
				}
			}
			if (changed) {
				for (let i = 0; i < logins.length; i++) {
					this.saveLogin(logins[i], oldLogin);
				}
			}
		}
	},

	getAllLogins: function getAllLogins(count) {
		var ret = this.filterLogins(true);
		if (count) {
			count.value = ret.length;
		}
		return ret;
	},

	removeAllLogins: function removeAllLogins() {
		this.pass(["rm", "-r", "-f", this._realm]);
		this._cache.clear();
	},

	getAllDisabledHosts: function getAllDisabledHosts(count) {
		this.stub(arguments);
	},

	getLoginSavingEnabled: function getLoginSavingEnabled(hostname) {
		return true;
	},

	setLoginSavingEnabled: function setLoginSavingEnabled(hostname, enabled) {
		this.stub(arguments);
	},

	searchLogins: function searchLogins() {
		this.stub(arguments);
	},

	findLogins: function findLogins(count, hostname, formSubmitURL, httpRealm) {
		var ret = this.filterLogins(true, hostname, formSubmitURL, httpRealm);
		if (count) {
			count.value = ret.length;
		}
		return ret;
	},

	countLogins: function countLogins(hostname, formSubmitURL, httpRealm) {
		var logins = this.filterLogins(false, hostname, formSubmitURL, httpRealm);
		return logins.length;
	},

	get uiBusy() {
		return this._uiBusy;
	},

	get isLoggedIn() {
		return true;
	}
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([PassManager]);
