using System;
using System.Collections.Generic;

sealed class FakeSession
{
    public string App;
    public bool Playing;
    public FakeSession(string app, bool playing) { App = app; Playing = playing; }
}

static class SelectionHarness
{
    static void Expect(string label, FakeSession actual, FakeSession expected)
    {
        if (!Object.ReferenceEquals(actual, expected)) throw new Exception("selection failed: " + label);
    }

    static int Main()
    {
        var browser = new FakeSession("chrome.exe", true);
        var spotify = new FakeSession("Spotify.exe", false);
        var musicbee = new FakeSession("MusicBee.exe", true);
        var sessions = new List<FakeSession> { browser, spotify, musicbee };
        Func<FakeSession, string> app = s => s.App;
        Func<FakeSession, bool> playing = s => s.Playing;

        // A filtered-out, playing Windows current session is never eligible.
        Expect("filtered current excluded", SmtcReader.Selection.Choose(sessions, browser, null, "spotify,musicbee", app, playing), musicbee);
        // A current eligible player wins when it is playing.
        Expect("current eligible playing", SmtcReader.Selection.Choose(sessions, musicbee, spotify, "spotify,musicbee", app, playing), musicbee);
        // Otherwise the first eligible playing session wins.
        Expect("first eligible playing", SmtcReader.Selection.Choose(sessions, spotify, null, "spotify,musicbee", app, playing), musicbee);
        musicbee.Playing = false;
        // On pause, keep the previous MusicBee session even though Windows current is Spotify.
        Expect("previous eligible paused", SmtcReader.Selection.Choose(sessions, spotify, musicbee, "spotify,musicbee", app, playing), musicbee);
        // A newly playing eligible session still outranks the previous paused one.
        spotify.Playing = true;
        Expect("eligible playing outranks previous", SmtcReader.Selection.Choose(sessions, musicbee, musicbee, "spotify,musicbee", app, playing), spotify);
        spotify.Playing = false;
        // The previous session is ignored when excluded by the filter or gone.
        Expect("excluded previous", SmtcReader.Selection.Choose(sessions, spotify, browser, "spotify,musicbee", app, playing), spotify);
        var remaining = new List<FakeSession> { browser, spotify };
        Expect("vanished previous", SmtcReader.Selection.Choose(remaining, spotify, musicbee, "musicbee", app, playing), null);
        Expect("no match", SmtcReader.Selection.Choose(sessions, browser, null, "vlc", app, playing), null);
        // Invalid filters fail closed instead of broadening to every app.
        Expect("invalid filter", SmtcReader.Selection.Choose(sessions, browser, null, "spotify,,musicbee", app, playing), null);
        return 0;
    }
}
