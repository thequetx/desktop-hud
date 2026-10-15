// smtc-reader — what Spotify is playing, read from Windows' media controls.
//
// The same session Windows shows in the volume flyout (System Media Transport
// Controls). Local and free: no Spotify Web API call, so it cannot use up the
// developer quota that Songify's polling kept exhausting (429 QUOTA_EXCEEDED,
// 2026-09-24/25). electron/nowplaying.cjs runs this and serves the result.
//
// Output: one JSON object per line on stdout, written when something changes
// and at least every HEARTBEAT_MS so the reader can tell it's alive:
//   { "ok": true, "title", "artist", "album", "playing", "positionMs",
//     "durationMs", "sampledAt", "coverKey", "cover" }
// or { "ok": false } when Spotify has no media session (closed, nothing loaded).
// `cover` (base64) is sent only when `coverKey` changes — a new track —
// otherwise it is null and the reader keeps the image it already has.
//
// Built with the C# 5 compiler that ships in .NET Framework 4 (see
// scripts/build-smtc.mjs), so no SDK is needed: C# 5 only, no $"" or ?.

using System;
using System.IO;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class SmtcReader
{
    const int TICK_MS = 1000;
    const int HEARTBEAT_MS = 5000;
    const int MAX_COVER_BYTES = 4 * 1024 * 1024;

    static int Main(string[] args)
    {
        // A word the player's app id must contain ("spotify"), or "*" / nothing
        // for any player (Phase 9.4).
        string match = args.Length > 0 ? args[0].ToLowerInvariant().Trim() : "*";
        if (match == "") match = "*";
        Console.OutputEncoding = new UTF8Encoding(false);
        GlobalSystemMediaTransportControlsSessionManager mgr;
        try
        {
            mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("smtc unavailable: " + e.Message);
            return 2;
        }

        string last = null;
        string lastCoverKey = null;
        DateTime lastWrite = DateTime.MinValue;
        while (true)
        {
            string line;
            string coverKey = null;
            string cover = null;
            try
            {
                GlobalSystemMediaTransportControlsSession session = Find(mgr, match);
                if (session == null)
                {
                    line = "{\"ok\":false}";
                }
                else
                {
                    var props = Wait(session.TryGetMediaPropertiesAsync());
                    var info = session.GetPlaybackInfo();
                    var tl = session.GetTimelineProperties();
                    bool playing = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                    coverKey = (props.Artist ?? "") + "\u001f" + (props.Title ?? "") + "\u001f" + (props.AlbumTitle ?? "");
                    if (coverKey != lastCoverKey && props.Thumbnail != null) cover = ReadThumbnail(props.Thumbnail);
                    // Position is as of LastUpdatedTime; the reader extrapolates.
                    line = "{\"ok\":true"
                        + ",\"title\":" + Str(props.Title)
                        + ",\"artist\":" + Str(props.Artist)
                        + ",\"album\":" + Str(props.AlbumTitle)
                        + ",\"playing\":" + (playing ? "true" : "false")
                        + ",\"positionMs\":" + (long)tl.Position.TotalMilliseconds
                        + ",\"durationMs\":" + (long)(tl.EndTime - tl.StartTime).TotalMilliseconds
                        + ",\"sampledAt\":" + tl.LastUpdatedTime.ToUnixTimeMilliseconds()
                        + ",\"coverKey\":" + Str(Hash(coverKey));
                }
            }
            catch (Exception e)
            {
                // Spotify closing mid-read, a session vanishing: report and carry on.
                Console.Error.WriteLine("read failed: " + e.Message);
                line = "{\"ok\":false}";
                coverKey = null;
            }

            bool changed = line != last;
            if (changed || cover != null || (DateTime.UtcNow - lastWrite).TotalMilliseconds >= HEARTBEAT_MS)
            {
                string outLine = line.StartsWith("{\"ok\":true")
                    ? line + ",\"cover\":" + (cover == null ? "null" : "\"" + cover + "\"") + "}"
                    : line;
                Console.Out.WriteLine(outLine);
                Console.Out.Flush();
                last = line;
                lastWrite = DateTime.UtcNow;
                // Only count the cover as sent once a thumbnail actually arrived:
                // Spotify sometimes publishes the title a beat before the art.
                if (cover != null)
                {
                    lastCoverKey = coverKey;
                    // A cover is a few MB of bytes plus its base64 text, both on
                    // the large-object heap, which .NET only reclaims on a full
                    // collection. Once per song, collect and compact it, so the
                    // reader stays small (Phase 9.6, Bug Log #62).
                    cover = null;
                    System.Runtime.GCSettings.LargeObjectHeapCompactionMode = System.Runtime.GCLargeObjectHeapCompactionMode.CompactOnce;
                    GC.Collect();
                }
            }
            Thread.Sleep(TICK_MS);
        }
    }

    // Any player: the one that is playing (the current one first, if it is),
    // else the session Windows calls current, else the first there is. One
    // player: the first whose app id contains the word.
    static GlobalSystemMediaTransportControlsSession Find(GlobalSystemMediaTransportControlsSessionManager mgr, string match)
    {
        var sessions = mgr.GetSessions();
        if (match != "*")
        {
            foreach (var s in sessions)
            {
                if ((s.SourceAppUserModelId ?? "").ToLowerInvariant().Contains(match)) return s;
            }
            return null;
        }
        var current = mgr.GetCurrentSession();
        if (current != null && IsPlaying(current)) return current;
        foreach (var s in sessions)
        {
            if (IsPlaying(s)) return s;
        }
        if (current != null) return current;
        foreach (var s in sessions) return s;
        return null;
    }

    static bool IsPlaying(GlobalSystemMediaTransportControlsSession s)
    {
        try
        {
            return s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        }
        catch
        {
            return false;
        }
    }

    static string ReadThumbnail(IRandomAccessStreamReference thumb)
    {
        try
        {
            using (IRandomAccessStreamWithContentType ras = Wait(thumb.OpenReadAsync()))
            using (var reader = new DataReader(ras))
            using (var ms = new MemoryStream())
            {
                reader.InputStreamOptions = InputStreamOptions.Partial;
                while (ms.Length < MAX_COVER_BYTES)
                {
                    uint n = Wait(reader.LoadAsync(64 * 1024));
                    if (n == 0) break;
                    var chunk = new byte[n];
                    reader.ReadBytes(chunk);
                    ms.Write(chunk, 0, chunk.Length);
                }
                return ms.Length > 0 && ms.Length < MAX_COVER_BYTES ? Convert.ToBase64String(ms.ToArray()) : null;
            }
        }
        catch
        {
            return null;
        }
    }

    // WinRT async without System.Runtime.WindowsRuntime's AsTask: that helper
    // needs the SDK's merged Windows.winmd, which a bare Windows install lacks.
    // Every call here is local and quick, so a short spin-wait is fine.
    static T Wait<T>(IAsyncOperation<T> op)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (op.Status == AsyncStatus.Started)
        {
            if (DateTime.UtcNow > deadline) { op.Cancel(); throw new TimeoutException("WinRT call timed out"); }
            Thread.Sleep(5);
        }
        if (op.Status != AsyncStatus.Completed) throw op.ErrorCode ?? new InvalidOperationException("WinRT call " + op.Status);
        return op.GetResults();
    }

    static string Hash(string s)
    {
        uint h = 2166136261;
        foreach (char c in s) { h ^= c; h *= 16777619; }
        return h.ToString("x8");
    }

    static string Str(string s)
    {
        if (s == null) return "\"\"";
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': b.Append("\\\""); break;
                case '\\': b.Append("\\\\"); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        return b.Append('"').ToString();
    }
}
