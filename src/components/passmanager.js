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
	username: "login",
	password: null,
	hostname: null,
	formSubmitURL: "url",
	httpRealm: "realm",
	usernameField: "loginfield",
	passwordField: "passfield"
};

const EnvironmentVars = [
	"HOME", "USER", "DISPLAY", "PATH",
	"GPG_AGENT_INFO",
	"PASSWORD_STORE_DIR",
	"PASSWORD_STORE_KEY",
	"PASSWORD_STORE_GIT",
	"PASSWORD_STORE_UMASK",
	"TREE_COLORS=",
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

	hash: function () {
		var h = Cc["@mozilla.org/security/hash;1"].
					createInstance(Ci.nsICryptoHash);
		var c = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
					createInstance(Ci.nsIScriptableUnicodeConverter);
		c.charset = "UTF-8";
		h.init(h.MD5);
		for (let i = 0; i < arguments.length; i++) {
			let arg = c.convertToByteArray(arguments[i], {});
			h.update(arg, arg.length);
		}
		var t = h.finish(false);
		return [("0" + t.charCodeAt(i).toString(16)).slice(-2)
			for (i in t)].join("");
	},

	sanitizeHostname: function (hostname) {
		return hostname.replace(/^.*:\/\//, "");
	},

	getHostnamePath: function (hostname) {
		if (hostname instanceof Ci.nsILoginInfo) {
			hostname = hostname.hostname;
		}
		return this._realm + "/" +
			this.sanitizeHostname(hostname);
	},

	getLoginName: function (hostname, formSubmitURL, httpRealm, username) {
		if (hostname instanceof Ci.nsILoginInfo) {
			formSubmitURL = hostname.formSubmitURL;
			httpRealm = hostname.httpRealm;
			username = hostname.username;
			hostname = hostname.hostname;
		}
		var h = this.hash(hostname,
				formSubmitURL ? formSubmitURL : "-",
				httpRealm ? httpRealm : "-");
		if (username) {
			return h + "-" + this.hash(h, username);
		}
		return h;
	},

	getLoginPath: function (hostname, formSubmitURL, httpRealm, username) {
		return this.getHostnamePath(hostname) + "/" +
			this.getLoginName(hostname, formSubmitURL, httpRealm, username);
	},

	loginToStr: function (login) {
		var s = new Array();
		s.push(login.password);
		for (let prop in PropertyMap) {
			if (PropertyMap[prop] && login[prop]) {
				s.push(PropertyMap[prop] + ": " + login[prop]);
			}
		}
		return s.join("\n");
	},

	strToLogin: function (s) {
		var login = new LoginInfo();
		var lines = s.split("\n");
		login.username = "";
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
			if (PropertyMap[prop] && props[PropertyMap[prop]]) {
				login[prop] = props[PropertyMap[prop]];
			}
		}
		return login;
	},

	loadLogin: function (hostname, loginName) {
		var result = this.pass(["show",
				this.getHostnamePath(hostname) + "/" + loginName]);
		if (result.exitCode != 0) {
			return null;
		}
		var login = this.strToLogin(result.stdout);
		if (login) {
			login.hostname = hostname;
			return login;
		}
		return null;
	},

	getHostnameLogins: function (hostname, formSubmitURL, httpRealm) {
		result = this.pass(["ls", this.getHostnamePath(hostname)]);
		if (result.exitCode != 0) {
			return new Array();
		}
		var filter = null;
		if (formSubmitURL || httpRealm) {
			filter = this.getLoginName(hostname, formSubmitURL, httpRealm);
		}
		var lines = result.stdout.split("\n");
		var re = /^.*[|`]+-- (.*)$/;
		var logins = new Array();
		for(let i = 0 ; i < lines.length; i++) {
			let match = re.exec(lines[i]);
			if(match && (!filter ||
						match[1].slice(0, filter.length) == filter)) {
				logins.push(match[1]);
			}
		}
		return logins;
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
		var prefs = Cc["@mozilla.org/preferences-service;1"].
				getService(Ci.nsIPrefService);
		prefs = prefs.getBranch("extensions.passmanager.");

		this._pass = prefs.getCharPref("pass");
		
		var realm = new Array(prefs.getCharPref("realm"));
		if (prefs.getBoolPref("realm.append_product")) {
			realm.push(Services.appinfo.name.toLowerCase());
		}
		this._realm = realm.join("/");
	},

	initialize: function () {
		this.init();
		return Promise.resolve();
	},

	terminate: function () {
		return Promise.resolve();
	},

	addLogin: function addLogin(login) {
		this.pass(["insert", "-m", "-f", this.getLoginPath(login)],
				this.loginToStr(login));
	},

	removeLogin: function removeLogin(login) {
		this.pass(["rm", "-f", this.getLoginPath(login)]);
	},

	modifyLogin: function modifyLogin(oldLogin, newLogin) {
		if (newLogin instanceof Ci.nsIPropertyBag) {
			let propEnum = newLogin.enumerator;
			let tmp = {};
			while (propEnum.hasMoreElements()) {
				let prop = propEnum.getNext().QueryInterface(Ci.nsIProperty);
				tmp[prop.name] = prop.value;
			}
			newLogin = tmp;
		}
		var changed = false;
		for (let prop in PropertyMap) {
			if (newLogin[prop] && oldLogin[prop] != newLogin[prop]) {
				oldLogin[prop] = newLogin[prop];
				changed = true;
			}
		}
		if (changed) {
			this.addLogin(oldLogin);
		}
	},

	getAllLogins: function getAllLogins(count) {
		this.stub(arguments);
	},

	removeAllLogins: function removeAllLogins() {
		this.stub(arguments);
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
		var logins = this.getHostnameLogins(hostname, formSubmitURL, httpRealm);
		var ret = new Array();
		for (let i = 0; i < logins.length; i ++) {
			let login = this.loadLogin(hostname, logins[i]);
			if (login) {
				ret.push(login);
			}
		}
		if (count) {
			count.value = ret.length;
		}
		return ret;
	},

	countLogins: function countLogins(hostname, formSubmitURL, httpRealm) {
		var logins = this.getHostnameLogins(hostname, formSubmitURL, httpRealm);
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
