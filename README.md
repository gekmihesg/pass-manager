WARNING
=======

**Not supported any more!**
This addon heavily relies on legacy features, which will no longer be supported by Firefox 57+ and there doesn't seem to be a way to port the functionality to WebExtensions. There is a final, untested build which might still work with Firefox 56.

pass-manager
============

Extension for Mozilla Firefox and Thunderbird.
Replaces the default password managers storage with [pass][1] by implementing
[nsILoginManagerStorage][2].

The implementation **is not complete** and probably never will be. It is
not possible to disable password saving for single domains.


### Migration
Because pass-manager replaces the default password storage backend, it is
compatible with plugins like [Password Exporter][3].

1. Install [Password Exporter][3]
2. Export saved passwords
3. Optionally delete all saved passwords
4. Install pass-manager
5. Import saved passwords

Switching back to the integrated storage engine works the other way around.


### Configuration
There are some options exposed via the ``about:config`` interface. The scope
is ``extensions.passmanager.*``. For people using a command line password
manager, this should be sufficient :-)


### Storage format
Passwords are stored in the subfolder ``mozilla/PRODUCT/DOMAIN/passmanager###``
by default. All other files in the three ``mozilla/PRODUCT/DOMAIN/`` will be
parsed, too.

The field mapping can be configured via about:config. By enabling the ``fuzzy``
option, missing ``hostname``, ``formSubmitURL`` and ``httpRealm`` fields will
be autocompleted with the values firefox expects. So the only required field
for a username/password login is ``username``. An entry like this would match
all protocols and forms for ``DOMAIN`` on any port.
For password only logins, no additional fields are required.


[1]: http://www.passwordstore.org/
[2]: https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsILoginManagerStorage
[3]: https://addons.mozilla.org/en-US/firefox/addon/password-exporter/
