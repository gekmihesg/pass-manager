pass-manager
============

Extension for Mozilla Firefox and Thunderbird.
Replaces the default password managers storage with
[pass](http://www.passwordstore.org/) by implementing
[nsILoginManagerStorage](https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsILoginManagerStorage).

The implementation **is not complete** and probably never will be. It is
not possible to disable password saving for single domains or to list all
saved passwords in the settings dialog.


### Configuration
There are some options exposed via the ``about:config`` interface. The scope
is ``extensions.passmanager.*``.


### Storage format
Passwords are stored in the subfolder ``mozilla/PRODUCT/DOMAIN`` by default.

```
mozilla
`-- firefox
    `-- example.com
        |-- 0123456789abcdef0123456789abcdef-0123456789abcdef0123456789abcdef
        `-- 0123456789abcdef0123456789abcdef-abcdef0123456789abcdef0123456789
```
The first hash is built from ``hostname``, ``actionURL`` and ``httpRealm``.
The second hash consists of the first hash and the username. This allows multiple
logins per domain, modifying saved passwords and more or less efficient searching,
while trying to disguise the username as securly as possible.

It is not intended to add login information by hand, but to keep all the other
advantages of pass.

### Status
This software is in **early developement state** and should not be used in
production environment!
