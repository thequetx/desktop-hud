# Calendars

Desktop HUD reads calendars in the **iCalendar** format, the format almost every calendar app can share. It feeds **Next up**, the **Today radar**, the **Week** bubble, **focus mode** and the **idle screen**. It never changes a calendar.

Add, fix or remove calendars in **Display & HUD → Integrations → Calendars**. You can add as many as you like.

## A calendar link

A calendar link is a private web address, usually ending in `.ics` (some start with `webcal://`). Desktop HUD checks it when you add it, then reads it again every 15 minutes. **Refresh now** reads every calendar at once.

**Treat the link like a password.** Anyone who has it can read that calendar. Desktop HUD stores it encrypted on your PC and never shows it again, not even to you. To change a link, remove the calendar and add it again, or use **Fix…** when it stops working.

## An .ics file

Choose **Add .ics file…** to read a calendar you've downloaded. A file is a snapshot: it doesn't update by itself. Download it again and add it again when it changes.

## Where to find your calendar link

### Google Calendar

1. On a computer, open Google Calendar.
2. Open **Settings** (the gear), then **Settings**.
3. Under **Settings for my calendars**, choose the calendar.
4. Choose **Integrate calendar**.
5. Copy **Secret address in iCal format**.

Use the *secret* address, not the public one: the public one works only if you've made the calendar public. If you ever share the secret address by mistake, **Reset** it there; then add the new one to Desktop HUD.

### Outlook (Outlook.com and Microsoft 365)

1. Open Outlook on the web and go to **Settings → Calendar → Shared calendars**.
2. Under **Publish a calendar**, choose the calendar and **Can view all details**.
3. Choose **Publish**.
4. Copy the **ICS** link (not the HTML one).

Some work or school accounts don't allow publishing. If the option is missing, ask your IT team, or export the calendar as an `.ics` file instead.

### Apple iCloud

1. Open Calendar on iCloud.com, or the Calendar app on an iPhone or iPad.
2. Open the calendar's sharing options and turn on **Public Calendar**.
3. Copy the link it shows. It starts with `webcal://`, which Desktop HUD accepts.

A public iCloud calendar can be seen by anyone who has the link.

### University timetable or Canvas

- **Canvas:** open **Calendar** and choose **Calendar Feed** (bottom right). Copy the link.
- **Other timetable systems:** look for **Subscribe**, **Export to calendar** or **iCal**. Copy the link it gives you. If it only offers a download, add the file instead.

## Status lights

Each calendar has a light: **blue** when it's being read normally, **red** when it isn't updating, **grey** before its first read. A red calendar says why (for example, "calendar fetch failed: HTTP 404") and keeps showing its last good copy until it works again.

**Fix…** lets you paste the link again, or a new one, and removes the old one once the new one works.

## Recurring blocks

Things that happen every week without being in a calendar, like work hours, a class or the gym, can be added in **Display & HUD → Screens → Recurring blocks**. Next up and the Today radar show them beside your calendar events. They're optional.
