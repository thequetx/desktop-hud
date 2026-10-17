# Now playing

The Now playing bubble reads a media session that an app publishes to Windows media controls. It can show the title, artist, cover and progress. Desktop HUD does not control playback.

Choose **Any player**, **One app only**, **Spotify + MusicBee**, or **Selected apps** in **Display & HUD → Integrations → Now playing**. The Spotify + MusicBee choice filters for the Windows app identities `spotify` and `musicbee`. For a custom list, separate up to four names with commas; each name can be 40 characters and the whole list can be 64 characters. Use the app identity Windows reports. Changes apply after Desktop HUD restarts.

## MusicBee

A standalone MusicBee installation does not publish a Windows media session for Desktop HUD out of the box. It needs a compatible SMTC (System Media Transport Controls) plugin, such as the community [mb_MediaControl plugin](https://github.com/HenryPDT/mb_MediaControl). This third-party plugin is maintained separately and is not bundled with Desktop HUD.

1. Download [mb_MediaControl.dll v1.0](https://github.com/HenryPDT/mb_MediaControl/releases/download/1.0/mb_MediaControl.dll) (85,504 bytes) from the [upstream v1.0 release](https://github.com/HenryPDT/mb_MediaControl/releases/tag/1.0).
2. Close MusicBee. For the installed Windows version of MusicBee, copy the DLL to `%APPDATA%\MusicBee\Plugins` (create the `Plugins` folder if it does not exist). This per-user location is writable without administrator permission. The [MusicBee plugin-development forum post](https://getmusicbee.com/forum/index.php?topic=38740.0) documents this writable per-user plugin folder for installer installations. For a portable MusicBee installation, copy the DLL to the `Plugins` subfolder beside the portable app.
3. Start MusicBee again. From its menu, choose **Edit → Edit Preferences** (or press **Ctrl+O**), then open **Plugins**. The plugin is enabled when its button says **Disable**; if the button says **Enable**, click it. No plugin configuration is needed.
4. Restart MusicBee and start playing a track. Confirm that Windows shows the track in its media controls.
5. In Desktop HUD, choose **Spotify + MusicBee** under **Display & HUD → Integrations → Now playing**, then choose **Apply and restart**.

If the MusicBee session appears in Windows media controls but Desktop HUD does not show it, Windows may be reporting a different app identity. Choose **Selected apps** and enter the identity reported for that session; the preset uses `musicbee`. The plugin only exposes the current media session. Desktop HUD does not scan the MusicBee library, sign in to a cloud service, or run a public HTTP server for music data.

