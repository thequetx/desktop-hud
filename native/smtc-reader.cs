// smtc-reader — what Spotify is playing, read from Windows' media controls.
//
// The same session Windows shows in the volume flyout (System Media Transport
// Controls). Local and free: no Spotify Web API call, so it cannot use up the
// developer quota that Songify's polling kept exhausting (429 QUOTA_EXCEEDED,
// 2026-09-24/25). electron/nowplaying.cjs runs this and serves the result.
//
// Output: one JSON object per line on stdout, written when something changes
// and at least every HEARTBEAT_MS so the reader can tell it's alive:
//   { "ok": true, "sourceAppId", "title", "artist", "album", "playing", "positionMs",
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
        // Comma-separated words the session app id must contain, or "*" / nothing.
        string match = args.Length > 0 ? args[0] : "*";
        string[] filters;
        if (!TryParseFilter(match, out filters))
        {
            Console.Error.WriteLine("invalid player filter");
            return 2;
        }
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
        GlobalSystemMediaTransportControlsSession previous = null;
        while (true)
        {
            string line;
            string coverKey = null;
            string cover = null;
            try
            {
                GlobalSystemMediaTransportControlsSession session = Find(mgr, filters, previous);
                // Keep the selected session through pauses; Choose drops it if it
                // disappears or falls outside the configured app filter.
                previous = session;
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
                    string sourceAppId = session.SourceAppUserModelId ?? "";
                    coverKey = sourceAppId + "\u001e" + (props.Artist ?? "") + "\u001f" + (props.Title ?? "") + "\u001f" + (props.AlbumTitle ?? "");
                    if (coverKey != lastCoverKey && props.Thumbnail != null) cover = ReadThumbnail(props.Thumbnail);
                    // Position is as of LastUpdatedTime; the reader extrapolates.
                    line = "{\"ok\":true"
                        + ",\"sourceAppId\":" + Str(sourceAppId)
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

    static bool TryParseFilter(string value, out string[] filters)
    {
        filters = new string[0];
        if (value == null) return false;
        string trimmed = value.Trim();
        if (trimmed == "" || trimmed == "*") return true;
        if (trimmed.Length > 64) return false;
        string[] parts = trimmed.Split(',');
        if (parts.Length > 4) return false;
        for (int i = 0; i < parts.Length; i++)
        {
            parts[i] = parts[i].Trim().ToLowerInvariant();
            if (!ValidName(parts[i])) return false;
        }
        filters = parts;
        return true;
    }

    static bool ValidName(string name)
    {
        if (name.Length < 1 || name.Length > 40) return false;
        if (!IsAlphaNum(name[0])) return false;
        for (int i = 1; i < name.Length; i++)
        {
            char c = name[i];
            if (!IsAlphaNum(c) && c != '.' && c != '_' && c != '-' && c != ' ') return false;
        }
        return true;
    }

    static bool IsAlphaNum(char c)
    {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    }

    static GlobalSystemMediaTransportControlsSession Find(GlobalSystemMediaTransportControlsSessionManager mgr, string[] filters,
        GlobalSystemMediaTransportControlsSession previous)
    {
        return Selection.Choose(mgr.GetSessions(), mgr.GetCurrentSession(), previous, String.Join(",", filters),
            s => s.SourceAppUserModelId,
            s => IsPlaying(s));
    }

    static bool IsPlaying(GlobalSystemMediaTransportControlsSession s)
    {
        try { return s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing; }
        catch { return false; }
    }

    // Pure selection helper used by the native reader and its executable tests.
    public static class Selection
    {
        public static T Choose<T>(System.Collections.Generic.IEnumerable<T> sessions, T current, T previous,
            string filter, Func<T, string> appId, Func<T, bool> playing) where T : class
        {
            string[] filters;
            if (!TryParseFilter(filter, out filters)) return default(T);
            var eligible = new System.Collections.Generic.List<T>();
            bool any = filters.Length == 0;
            foreach (T session in sessions)
            {
                string id = (appId(session) ?? "").ToLowerInvariant();
                bool matches = any;
                for (int i = 0; !matches && i < filters.Length; i++) matches = id.Contains(filters[i]);
                if (matches) eligible.Add(session);
            }
            bool currentEligible = current != null && eligible.Contains(current);
            if (currentEligible && playing(current)) return current;
            foreach (T session in eligible) if (playing(session)) return session;
            if (previous != null && eligible.Contains(previous)) return previous;
            if (currentEligible) return current;
            return eligible.Count > 0 ? eligible[0] : default(T);
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
