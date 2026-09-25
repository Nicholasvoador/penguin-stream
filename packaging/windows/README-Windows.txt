Penguin Stream for Windows (x64)
================================

Start
-----
1. Extract the whole zip (right-click > Extract All...). Do not run it from
   inside the zip.
2. Double-click "Penguin Stream". A console window opens (keep it open; close
   it to quit) and the app opens in your web browser.
   - Windows SmartScreen may say "Windows protected your PC" because this
     build is not code-signed: click "More info" > "Run anyway".
   - Windows Firewall may ask about "Node.js JavaScript Runtime": allow it on
     private networks, otherwise direct connections can fail.

Share this PC:  click "Share this screen", send the invitation to the other
                person privately, and approve them when the four verification
                words match on both screens.
View a PC:      click "Connect to a screen" and paste the invitation you got.

No accounts, port forwarding or servers are needed: the two computers find
each other through public Nostr relays (only encrypted data passes through
them) and then connect directly peer-to-peer.

Controllers
-----------
Viewers need nothing extra: plug in any controller SDL supports (Xbox,
PlayStation, Switch Pro, 8BitDo, ...).
A Windows PC that is SHARING its screen needs the free ViGEmBus driver to
receive controllers (it creates virtual Xbox 360 pads for games). Open
"Install controller driver (ViGEmBus)", download and run the installer,
then restart Penguin Stream. "Check this PC" shows whether it is detected.

Keyboard, mouse and controllers can each be switched on/off at any time, by
the host (what it allows) and by the viewer (what it sends).

In the stream window hold Ctrl+Alt+Shift and press:
  Q  disconnect        M  keyboard+mouse on/off     G  controllers on/off
  Z  game mode (mouse locked in the window, for 3D games)
  X  fullscreen

Keys are sent by physical position, so both computers should use the same
keyboard layout (for example both ABNT2) to type the same characters.

Known limitations
-----------------
- Windows hosts cannot send audio yet.
- Programs running as Administrator (and the UAC prompt itself) ignore remote
  keyboard/mouse unless Penguin Stream is also run as Administrator.
- The lock screen and UAC prompts are not visible remotely; the stream keeps
  showing the last image and resumes afterwards.

Troubleshooting: double-click "Check this PC". Open the "Activity Log" in
the app for details. Report issues at
https://github.com/Nicholasvoador/penguin-stream/issues
