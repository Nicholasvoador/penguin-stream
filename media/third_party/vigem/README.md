Vendored from https://github.com/nefarius/ViGEmClient at b66d02d57e32cc8595369c53418b843e958649b4
(MIT, see LICENSE). Local change: lowercase `<windows.h>`/`<setupapi.h>` includes so the
source also builds with case-sensitive MinGW cross toolchains. Runtime requires the
ViGEmBus driver (https://github.com/nefarius/ViGEmBus/releases) on the Windows host.
