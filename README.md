pass-manager
============

Extension for Mozilla Firefox and Thunderbird.
Replaces the default password managers storage with [pass][1] by implementing
[nsILoginManagerStorage][2].

The implementation **is not complete** and probably never will be. It is
not possible to disable password saving for single domains.


### Configuration
There are some options exposed via the ``about:config`` interface. The scope
is ``extensions.passmanager.*``.


### Storage format
Passwords are stored in the subfolder ``mozilla/PRODUCT/DOMAIN/passmanager###``
by default. All other files in the three ``mozilla/PRODUCT/DOMAIN/`` will be
parsed, too.

Currently every file needs some specific fields, which are mapped to a
[nsILoginInfo][3] object. In future versions, there may be some kind of fuzzy
autocompletion.


### Status
This software is in **early developement state** and should not be used in
production environment!

[1]: http://www.passwordstore.org/
[2]: https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsILoginManagerStorage
[3]: https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsILoginInfo
