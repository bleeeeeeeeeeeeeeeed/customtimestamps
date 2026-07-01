import { findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { after, before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { React, ReactNative } from "@vendetta/metro/common";

const { FormSection, FormRow, FormInput, FormDivider, FormText } = Forms;

const Icon = (name: string) => {
  const source = getAssetIDByName?.(name);
  return source ? <FormRow.Icon source={source} /> : undefined;
};

// A reliable toggle built only on FormRow.onPress (which works everywhere here),
// with a plain ON/OFF text indicator — no dependency on FormSwitch, so it can't
// end up stuck or crash on a build that lacks/behaves oddly with it.
function ToggleRow({ label, subLabel, leading, value, onToggle }: any) {
  return (
    <FormRow
      label={label}
      subLabel={subLabel}
      leading={leading}
      trailing={<FormText style={{ fontWeight: "600", opacity: value ? 1 : 0.5 }}>{value ? "ON" : "OFF"}</FormText>}
      onPress={() => onToggle(!value)}
    />
  );
}

storage.overrides ??= {}; // { [messageId]: epochMillis }
storage.hideSetTimeButton ??= false; // hide the "Set custom time" action-sheet row
storage.syncDMList ??= true; // make the DM list time + order follow overrides
storage.debugCapture ??= false; // capture non-message row structures for troubleshooting

const RowManager = findByName("RowManager");
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const moment = findByProps("isMoment");
const MessageStore = findByStoreName("MessageStore");
const SelectedChannelStore = findByStoreName("SelectedChannelStore");
const ChannelStore = findByStoreName("ChannelStore");
const dmModule = findByProps("getDMFromUserId");

const patches: (() => void)[] = [];
let dumped = false;

function timeOnly(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Mirror Discord's relative format: today -> time only, yesterday -> "Yesterday at ...", older -> date + time.
function formatStamp(epoch: number): string {
  const d = new Date(epoch);
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const t = new Date(now); t.setDate(now.getDate() + 1);
  if (sameDay(d, now)) return timeOnly(d);
  if (sameDay(d, y)) return "Yesterday at " + timeOnly(d);
  if (sameDay(d, t)) return "Tomorrow at " + timeOnly(d);
  return d.toLocaleDateString() + " " + timeOnly(d);
}

// Parse "5:30 AM", "Yesterday at 2:30 AM", "Tomorrow at 1:00 PM", "5/31/2026 12:20 PM", "14:30".
function parseStamp(input: string): number {
  let s = input.trim();
  let base = new Date();
  const lower = s.toLowerCase();
  if (lower.startsWith("yesterday")) {
    base.setDate(base.getDate() - 1);
    s = s.replace(/yesterday\s*(at)?\s*/i, "");
  } else if (lower.startsWith("tomorrow")) {
    base.setDate(base.getDate() + 1);
    s = s.replace(/tomorrow\s*(at)?\s*/i, "");
  } else {
    const dm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(.*)$/);
    if (dm) {
      const yr = +dm[3] < 100 ? 2000 + +dm[3] : +dm[3];
      base = new Date(yr, +dm[1] - 1, +dm[2]);
      s = dm[4];
    }
  }
  const tm = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!tm) return NaN;
  let h = +tm[1];
  const min = +tm[2];
  const ap = tm[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  base.setHours(h, min, 0, 0);
  return base.getTime();
}

function toFields(epoch: number) {
  const d = new Date(epoch);
  let h = d.getHours();
  const pm = h >= 12;
  h = h % 12;
  if (h === 0) h = 12;
  return {
    month: String(d.getMonth() + 1),
    day: String(d.getDate()),
    year: String(d.getFullYear()),
    hour: String(h),
    minute: String(d.getMinutes()).padStart(2, "0"),
    pm,
  };
}

function safeEpoch(value: any): number {
  try {
    const t = new Date(value).getTime();
    return isNaN(t) ? Date.now() : t;
  } catch {
    return Date.now();
  }
}

// ---- DM list sync ----------------------------------------------------------
// The DM list shows each channel's last-message time and sorts by it; both come
// from the channel's `lastMessageId` snowflake (its top 42 bits encode the ms).
// We can therefore build a fake id that decodes to any time we want, so the
// native list both displays and orders the DM as if sent at the override time.
const DISCORD_EPOCH = 1420070400000;

function snowflakeFromEpoch(ms: number): string | null {
  try {
    if (typeof BigInt === "undefined") return null;
    return ((BigInt(Math.floor(ms)) - BigInt(DISCORD_EPOCH)) << BigInt(22)).toString();
  } catch {
    return null;
  }
}

// channelId -> the genuine lastMessageId we replaced, and the fake we wrote in
// its place. Lets us tell our own synthetic id apart from a brand-new real
// message (so a freshly sent message is picked up instead of ignored) and lets
// us restore the original on unload or when an override is removed.
const dmRealId: Record<string, string> = {};
const dmFakeId: Record<string, string> = {};

function syncChannelLastMessage(channel: any): void {
  try {
    if (!channel?.id) return;
    const cid = channel.id;
    const cur = channel.lastMessageId;

    // Recover the genuine last message id. If the current value is the fake we
    // last wrote, the real id is the one we stashed; otherwise Discord set a
    // genuine value (an unchanged or newly arrived message) — trust it.
    let real: string | null | undefined;
    if (cur != null && cur === dmFakeId[cid]) {
      real = dmRealId[cid];
    } else {
      real = cur;
      delete dmRealId[cid];
      delete dmFakeId[cid];
    }

    if (real == null) return;

    const ov = storage.syncDMList ? storage.overrides[real] : undefined;
    if (ov != null) {
      const fake = snowflakeFromEpoch(ov);
      if (fake) {
        dmRealId[cid] = real;
        dmFakeId[cid] = fake;
        channel.lastMessageId = fake;
        return;
      }
    }
    // No (usable) override, or the feature is off: make sure the real id stands.
    if (channel.lastMessageId !== real) channel.lastMessageId = real;
    delete dmRealId[cid];
    delete dmFakeId[cid];
  } catch {}
}

function restoreAllChannels(): void {
  for (const cid of Object.keys(dmRealId)) {
    try {
      const ch = ChannelStore?.getChannel?.(cid);
      if (ch && dmRealId[cid]) ch.lastMessageId = dmRealId[cid];
    } catch {}
    delete dmRealId[cid];
    delete dmFakeId[cid];
  }
}

function getMessagesArray(channelId: string): any[] {
  const col = MessageStore?.getMessages?.(channelId);
  if (!col) return [];
  if (typeof col.toArray === "function") return col.toArray();
  if (Array.isArray(col._array)) return col._array;
  return [];
}

// ---- Grouping + date divider (safe, output-only) --------------------------
// How close (in spoofed time) two same-author messages must be to render as one
// group. Discord's own window is ~7 min; a little wider feels natural for spoofs.
const GROUP_WINDOW_MS = 10 * 60 * 1000;

// Find a message's immediate predecessor without rescanning the channel each
// render. Cache is keyed by channel + message count so new messages refresh it.
let grpCache: { channelId: string; len: number; map: Record<string, number>; msgs: any[] } | null = null;
function prevMessageOf(msg: any): any {
  try {
    const channelId = msg?.channel_id;
    if (!channelId) return null;
    let len = -1;
    try { len = MessageStore?.getMessages?.(channelId)?.length ?? -1; } catch {}
    if (!grpCache || grpCache.channelId !== channelId || grpCache.len !== len) {
      const msgs = getMessagesArray(channelId);
      const map: Record<string, number> = {};
      for (let i = 0; i < msgs.length; i++) map[msgs[i].id] = i;
      grpCache = { channelId, len: msgs.length, map, msgs };
    }
    const idx = grpCache.map[msg.id];
    if (idx == null || idx <= 0) return null;
    return grpCache.msgs[idx - 1];
  } catch { return null; }
}

// Should this message tuck under the previous one (same author, close in spoofed
// time, not a reply)? Uses each message's effective time (override or real) so
// spoofing two messages near each other groups them like a normal pair.
function groupsWithPrev(msg: any): boolean {
  try {
    if (msg?.messageReference) return false;
    const prev = prevMessageOf(msg);
    if (!prev) return false;
    if (msg.author?.id !== prev.author?.id) return false;
    const tCur = storage.overrides[msg.id] ?? safeEpoch(msg.timestamp);
    const tPrev = storage.overrides[prev.id] ?? safeEpoch(prev.timestamp);
    const gap = tCur - tPrev;
    return gap >= 0 && gap <= GROUP_WINDOW_MS;
  } catch { return false; }
}

// Discord's in-chat date-separator wording, e.g. "June 24, 2026".
function dividerDateStr(ms: number): string {
  try { return new Date(ms).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }); }
  catch { return ""; }
}

// The date separator is its own row (no `.message`), so we can't key it off a
// message id. Instead build a map of every real day-string that an override
// moves to a different day -> the spoofed day-string, taken from the first
// message of each real day. Then we just relabel any matching date text in any
// row. Cached per channel + message count.
type DayEntry = { str: string; ms: number };
function buildDayMap(channelId: string): Record<string, DayEntry> {
  const map: Record<string, DayEntry> = {};
  const msgs = getMessagesArray(channelId); // oldest -> newest
  let lastRealDay = "";
  for (const m of msgs) {
    const realDay = dividerDateStr(safeEpoch(m.timestamp));
    if (realDay === lastRealDay) continue; // only the first message of each real day
    lastRealDay = realDay;
    const ov = storage.overrides[m.id];
    if (ov != null) {
      const spoofDay = dividerDateStr(ov);
      if (spoofDay && spoofDay !== realDay) map[realDay] = { str: spoofDay, ms: ov };
    }
  }
  return map;
}

// Channel of the most recent message row seen by generate — used to attribute
// separator rows (which have no channel) to the correct channel.
let lastRowChannelId: string | undefined;

let dayMapCache: { channelId: string; len: number; map: Record<string, DayEntry> } | null = null;
function getDayMap(channelId: string): Record<string, DayEntry> {
  let len = -1;
  try { len = MessageStore?.getMessages?.(channelId)?.length ?? -1; } catch {}
  if (!dayMapCache || dayMapCache.channelId !== channelId || dayMapCache.len !== len) {
    dayMapCache = { channelId, len, map: buildDayMap(channelId) };
  }
  return dayMapCache.map;
}

// The day-string of a timestamp-ish value (epoch number, Date, or moment).
function dayOfValue(v: any): string | null {
  try {
    let ms: number;
    if (typeof v === "number") {
      if (v < 1e12 || v > 2e13) return null; // not a plausible ms epoch
      ms = v;
    } else if (v instanceof Date) {
      ms = v.getTime();
    } else if (v && v._isAMomentObject && typeof v.valueOf === "function") {
      ms = v.valueOf();
    } else return null;
    return dividerDateStr(ms);
  } catch { return null; }
}

// Return `v` with its calendar day shifted to that of `spoofMs`, preserving type.
function shiftToDay(v: any, spoofMs: number): any {
  try {
    const d0 = new Date(spoofMs);
    if (typeof v === "number") {
      const d = new Date(v); d.setFullYear(d0.getFullYear(), d0.getMonth(), d0.getDate()); return d.getTime();
    }
    if (v instanceof Date) {
      const d = new Date(v.getTime()); d.setFullYear(d0.getFullYear(), d0.getMonth(), d0.getDate()); return d;
    }
    if (v && typeof v.clone === "function" && typeof v.set === "function") {
      return v.clone().set({ year: d0.getFullYear(), month: d0.getMonth(), date: d0.getDate() });
    }
    return v;
  } catch { return v; }
}

// Output-only, fully guarded: the rows generate() returns are plain data objects
// (that's why setting row.message.timestamp works), so walk the row's own
// properties — not React props — and relabel any date, whether it's a finished
// string ("June 24, 2026") or a timestamp value (epoch number / Date / moment)
// whose day was spoofed. Never touches generate's input, so it can't crash.
function remapDates(row: any, channelId: string | undefined): void {
  try {
    if (!channelId) return;
    const map = getDayMap(channelId);
    if (!map || !Object.keys(map).length) return;
    const seen = new Set<any>();
    const walk = (node: any, depth: number) => {
      if (!node || depth > 8 || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
      for (const key of Object.keys(node)) {
        let val: any;
        try { val = node[key]; } catch { continue; }
        if (typeof val === "string") {
          if (map[val]) { try { node[key] = map[val].str; } catch {} }
        } else if (typeof val === "number") {
          const day = dayOfValue(val);
          if (day && map[day]) { try { node[key] = shiftToDay(val, map[day].ms); } catch {} }
        } else if (val && typeof val === "object") {
          const day = dayOfValue(val); // Date / moment
          if (day && map[day]) { try { node[key] = shiftToDay(val, map[day].ms); } catch {} }
          else walk(val, depth + 1);
        }
      }
    };
    walk(row, 0);
  } catch {}
}

// ---- Debug capture (off by default) ---------------------------------------
// Compactly describe a value so the structure of a non-message row can be read
// in the settings screen. Depth/size limited and cycle-safe.
function describeNode(node: any, depth: number, seen: Set<any>): string {
  try {
    if (node == null) return String(node);
    const t = typeof node;
    if (t === "string") return JSON.stringify(node.length > 50 ? node.slice(0, 50) + "…" : node);
    if (t === "number" || t === "boolean") return String(node);
    if (t === "function") return "ƒ";
    if (depth > 3) return "…";
    if (seen.has(node)) return "<cycle>";
    seen.add(node);
    if (node instanceof Date) return "Date(" + node.toISOString() + ")";
    if (node._isAMomentObject) { try { return "moment(" + node.format() + ")"; } catch { return "moment"; } }
    if (Array.isArray(node))
      return "[" + node.slice(0, 5).map((n) => describeNode(n, depth + 1, seen)).join(", ") +
        (node.length > 5 ? ", +" + (node.length - 5) : "") + "]";
    const keys = Object.keys(node).slice(0, 14);
    return "{" + keys.map((k) => k + ": " + describeNode(node[k], depth + 1, seen)).join(", ") +
      (Object.keys(node).length > 14 ? ", …" : "") + "}";
  } catch { return "?"; }
}

function captureRow(row: any): void {
  try {
    if ((storage.debugDump || "").length > 4500) return; // keep it bounded
    const s = describeNode(row, 0, new Set());
    const sig = s.slice(0, 60);
    if ((storage.debugSeen || "").indexOf(sig) !== -1) return; // already captured this shape
    storage.debugSeen = ((storage.debugSeen || "") + "¦" + sig).slice(-3000);
    storage.debugDump = ((storage.debugDump || "") + "\n\n" + s).slice(-6000);
  } catch {}
}

// Parse a gap spec like "4-7", "4-7h", "30-90m", "45m", "5" into [minMs, maxMs].
function parseGap(spec: string): [number, number] {
  const s = (spec || "").trim().toLowerCase();
  const unit = s.includes("m") && !s.includes("h") ? 60000 : 3600000; // default hours
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return [4 * 3600000, 7 * 3600000];
  if (nums.length === 1) { const v = +nums[0] * unit; return [v, v]; }
  return [+nums[0] * unit, +nums[1] * unit];
}

// Group messages into blocks like Discord: new block when sender changes, >7 min gap, or a reply.
function buildBlocks(msgs: any[]): any[] {
  const GAP = 7 * 60 * 1000;
  const blocks: any[] = [];
  let prevAuthor: string | undefined;
  let prevTime = 0;
  for (const m of msgs) {
    const authorId = m.author?.id;
    const t = safeEpoch(m.timestamp);
    const isReply = !!m.messageReference;
    if (!blocks.length || authorId !== prevAuthor || t - prevTime > GAP || isReply) blocks.push(m);
    prevAuthor = authorId;
    prevTime = t;
  }
  return blocks;
}

// ---------------- Settings screen (tool icon) ----------------
function Settings() {
  useProxy(storage);
  const sel = storage.selectedMessage;
  const [f, setF] = React.useState(() =>
    toFields(sel ? storage.overrides[sel.id] ?? sel.original ?? Date.now() : Date.now())
  );
  // Persisted across closing the settings screen.
  const friendId = storage.channelId ?? "";
  const seq = storage.seqText ?? "";

  React.useEffect(() => {
    if (sel) setF(toFields(storage.overrides[sel.id] ?? sel.original ?? Date.now()));
  }, [sel?.id]);

  const up = (k: string, v: string | boolean) => setF((p: any) => ({ ...p, [k]: v }));
  const numField = (key: string, title: string) => (
    <FormInput
      title={title}
      value={String(f[key])}
      keyboardType="numeric"
      onChange={(v: string) => up(key, v)}
      onChangeText={(v: string) => up(key, v)}
    />
  );

  const saveOne = () => {
    if (!sel) { showToast("Long-press a message first"); return; }
    const Y = +f.year, M = +f.month, D = +f.day, mm = +f.minute;
    let h = +f.hour % 12;
    if (f.pm) h += 12;
    if ([Y, M, D, mm, h].some((n) => isNaN(n))) { showToast("Check the numbers"); return; }
    const epoch = new Date(Y, M - 1, D, h, mm, 0, 0).getTime();
    if (isNaN(epoch)) { showToast("Invalid date/time"); return; }
    storage.overrides[sel.id] = epoch;
    showToast("Saved — scroll the chat to refresh");
  };

  const applySequence = () => {
    const lines = seq.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { showToast("Add some times first"); return; }

    let channelId: string | undefined = friendId.trim() || undefined;
    if (!channelId) channelId = SelectedChannelStore?.getChannelId?.();
    if (!channelId) { showToast("Open the DM, or enter a Channel ID"); return; }

    const msgs = getMessagesArray(channelId); // ascending: oldest -> newest
    if (!msgs.length) { showToast("No loaded messages — open/scroll the DM first"); return; }
    const blocks = buildBlocks(msgs);

    // One time per block, applied to the block's leading message (the one that shows a timestamp).
    let applied = 0;
    for (let i = 0; i < lines.length && i < blocks.length; i++) {
      const ep = parseStamp(lines[i]);
      if (!isNaN(ep)) { storage.overrides[blocks[i].id] = ep; applied++; }
    }
    showToast("blocks=" + blocks.length + " applied=" + applied + " — scroll to refresh");
  };

  const applyDistance = () => {
    let channelId: string | undefined = friendId.trim() || undefined;
    if (!channelId) channelId = SelectedChannelStore?.getChannelId?.();
    if (!channelId) { showToast("Open the DM, or enter a Channel ID"); return; }

    let start = parseStamp((storage.distStart ?? "").trim() || "Yesterday 8:30 PM");
    if (isNaN(start)) { showToast("Bad start time"); return; }

    const [minMs, maxMs] = parseGap(storage.distRange ?? "4-7");

    const msgs = getMessagesArray(channelId);
    if (!msgs.length) { showToast("No loaded messages — open/scroll the DM first"); return; }
    const blocks = buildBlocks(msgs); // oldest -> newest

    // Pick the random gaps up front so we know the full span (oldest..newest)
    // before deciding where to anchor it.
    const offsets: number[] = [0];
    for (let i = 1; i < blocks.length; i++) {
      offsets.push(offsets[i - 1] + minMs + Math.random() * (maxMs - minMs));
    }
    const totalSpan = offsets[offsets.length - 1];

    // Messages live in the past, so the newest block can't be in the future.
    // If walking forward from `start` would overshoot now, slide the whole
    // sequence back (by as many days as needed) so the newest block lands at now.
    const now = Date.now();
    let shifted = false;
    if (start + totalSpan > now) {
      start = now - totalSpan;
      shifted = true;
    }

    let applied = 0;
    for (let i = 0; i < blocks.length; i++) {
      storage.overrides[blocks[i].id] = Math.round(start + offsets[i]);
      applied++;
    }
    showToast(
      "Distanced " + applied + " blocks" +
      (shifted ? " (shifted back to fit before now)" : "") +
      " — scroll to refresh"
    );
  };

  const ovr = storage.overrides ?? {};
  const ovrIds = Object.keys(ovr);
  const targetMs = sel ? (storage.overrides[sel.id] ?? sel.original ?? Date.now()) : null;

  return (
    <ReactNative.ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 600 }}
      keyboardShouldPersistTaps="handled"
    >
      <FormText style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 2, opacity: 0.6 }}>
        Long-press a message → “Set custom time”, then edit the date & time below.
        Bulk tools relabel an entire DM at once.
      </FormText>

      {/* ---- Selected message ---- */}
      <FormSection title="Selected message">
        <FormRow
          label={sel ? sel.preview : "Nothing selected"}
          subLabel={
            sel
              ? "Currently shows: " + formatStamp(targetMs as number)
              : "Long-press a message and tap “Set custom time”"
          }
          leading={Icon("ic_message_edit")}
        />
        {sel ? (
          <>
            <FormDivider />
            <FormRow
              label="Deselect"
              leading={Icon("ic_close_circle_24px")}
              onPress={() => { try { delete storage.selectedMessage; showToast("Deselected"); } catch {} }}
            />
          </>
        ) : null}
      </FormSection>

      {/* ---- Edit the time for the selected message ---- */}
      <FormSection title="Edit time">
        {numField("month", "Month (1–12)")}
        {numField("day", "Day")}
        {numField("year", "Year")}
        <FormDivider />
        {numField("hour", "Hour (1–12)")}
        {numField("minute", "Minute")}
        <ToggleRow
          label={f.pm ? "PM" : "AM"}
          subLabel={f.pm ? "Afternoon / evening" : "Morning"}
          leading={Icon("clock")}
          value={!!f.pm}
          onToggle={(v: boolean) => up("pm", v)}
        />
        <FormDivider />
        <FormRow
          label="Save for selected message"
          subLabel={sel ? undefined : "Select a message first"}
          leading={Icon("ic_check_24px")}
          disabled={!sel}
          onPress={saveOne}
        />
      </FormSection>

      {/* ---- Bulk relabel a whole DM ---- */}
      <FormSection title="Bulk tools · whole DM">
        <FormInput
          title="Channel ID"
          placeholder="Blank = current DM"
          value={friendId}
          keyboardType="numeric"
          onChange={(v: string) => { storage.channelId = v; }}
          onChangeText={(v: string) => { storage.channelId = v; }}
        />
        <FormDivider />
        <FormInput
          title="Sequence · times oldest first (one per line or comma-separated)"
          placeholder="Yesterday at 2:30 AM, 5:30 AM, 2:23 PM, 5:34 PM"
          value={seq}
          multiline={true}
          onChange={(v: string) => { storage.seqText = v; }}
          onChangeText={(v: string) => { storage.seqText = v; }}
        />
        <FormRow label="Apply sequence" leading={Icon("ic_history")} onPress={applySequence} />
        <FormDivider />
        <FormInput
          title="Auto-distance · start time (first block)"
          placeholder="Yesterday 8:30 PM"
          value={storage.distStart ?? ""}
          onChange={(v: string) => { storage.distStart = v; }}
          onChangeText={(v: string) => { storage.distStart = v; }}
        />
        <FormInput
          title="Auto-distance · gap between blocks"
          placeholder="4-7h, 30-90m, 45m, 5h…"
          value={storage.distRange ?? ""}
          onChange={(v: string) => { storage.distRange = v; }}
          onChangeText={(v: string) => { storage.distRange = v; }}
        />
        <FormRow label="Auto-distance blocks" leading={Icon("ic_activity_24px")} onPress={applyDistance} />
      </FormSection>

      {/* ---- Toggles ---- */}
      <FormSection title="Options">
        <ToggleRow
          label="Sync DM list"
          subLabel="DM-list time & order follow the spoofed last message"
          leading={Icon("ic_message_retry")}
          value={!!storage.syncDMList}
          onToggle={(v: boolean) => {
            storage.syncDMList = v;
            if (!v) restoreAllChannels();
            showToast(v ? "DM list sync on" : "DM list sync off");
          }}
        />
        <FormDivider />
        <ToggleRow
          label="Hide “Set custom time” button"
          subLabel="Removes the row from the long-press menu"
          leading={Icon("ic_eye_hide_24px")}
          value={!!storage.hideSetTimeButton}
          onToggle={(v: boolean) => {
            storage.hideSetTimeButton = v;
            showToast(v ? "Button hidden" : "Button shown");
          }}
        />
      </FormSection>

      {/* ---- Active overrides ---- */}
      <FormSection title={"Active overrides · " + ovrIds.length}>
        <FormRow
          label="Clear all overrides"
          leading={Icon("ic_trash_24px")}
          disabled={!ovrIds.length}
          onPress={() => { storage.overrides = {}; showToast("Cleared all overrides"); }}
        />
        {ovrIds.length === 0 ? (
          <>
            <FormDivider />
            <FormRow label="No overrides yet" subLabel="Saved times will appear here" />
          </>
        ) : (
          ovrIds.map((id) => (
            <React.Fragment key={id}>
              <FormDivider />
              <FormRow
                label={formatStamp(ovr[id])}
                subLabel={"Tap to remove · " + id}
                leading={Icon("ic_timer")}
                onPress={() => { delete storage.overrides[id]; showToast("Removed"); }}
              />
            </React.Fragment>
          ))
        )}
      </FormSection>

      {/* ---- Debug (only for troubleshooting the date separator) ---- */}
      <FormSection title="Debug">
        <ToggleRow
          label="Capture row structure"
          subLabel="Turn on, open a DM with a spoofed date, come back here"
          leading={Icon("ic_bug")}
          value={!!storage.debugCapture}
          onToggle={(v: boolean) => {
            storage.debugCapture = v;
            if (v) { storage.debugDump = ""; storage.debugSeen = ""; }
            showToast(v ? "Capturing — open a spoofed DM" : "Capture off");
          }}
        />
        <FormDivider />
        <FormRow
          label="Clear capture"
          leading={Icon("ic_trash_24px")}
          onPress={() => { storage.debugDump = ""; storage.debugSeen = ""; showToast("Cleared"); }}
        />
        <FormText style={{ padding: 12, fontSize: 11, fontFamily: "monospace" }}>
          {storage.debugDump || "(nothing captured yet)"}
        </FormText>
      </FormSection>
    </ReactNative.ScrollView>
  );
}

// ---------------- Patches ----------------
function setup() {
  // 1) DISPLAY: relabel overridden messages by editing the already-generated row
  // (a shallow copy) *after* generate has run. Discord's generate never receives
  // our value — feeding it a rebuilt timestamp crashed the client. Two cases:
  //   • grouped (same author, close spoofed time) -> render as a continuation so
  //     the message tucks under the previous one with no repeated header;
  //   • block leader -> show the header with the spoofed time, and best-effort
  //     fix the date separator baked into the row.
  if (RowManager?.prototype?.generate) {
    patches.push(
      after("generate", RowManager.prototype, ([data]: any, row: any) => {
        try {
          const msg = row?.message;
          const id = msg?.id;

          // Remember the channel of the surrounding messages so separator rows
          // (which carry no channel) can be tied to the right day-map even if
          // the "selected channel" store is momentarily stale during load.
          if (msg?.channel_id) lastRowChannelId = msg.channel_id;

          // Non-message rows (e.g. the date separator) — relabel any date text.
          if (!id) {
            remapDates(row, lastRowChannelId || SelectedChannelStore?.getChannelId?.());
            if (storage.debugCapture) captureRow(row);
            return;
          }

          if (storage.overrides[id] == null) return;
          const custom = storage.overrides[id];

          if (groupsWithPrev(msg)) {
            row.message = { ...row.message, renderContentOnly: true };
            row.renderContentOnly = true;
            return;
          }

          const ts = msg.timestamp;
          let newTs: any = ts;
          if (typeof ts === "string" || ts == null) {
            newTs = formatStamp(custom);
          } else if (ts?.clone && ts?.set) {
            const d = new Date(custom);
            newTs = ts.clone().set({
              year: d.getFullYear(),
              month: d.getMonth(),
              date: d.getDate(),
              hour: d.getHours(),
              minute: d.getMinutes(),
              second: 0,
              millisecond: 0,
            });
          } else if (moment) {
            newTs = moment(custom);
          }
          row.message = { ...row.message, timestamp: newTs, renderContentOnly: false };
          row.renderContentOnly = false;
        } catch {}
      })
    );
  }

  // 2) ACTION SHEET: add a "Set custom time" row that selects the message
  if (LazyActionSheet?.openLazy) {
    patches.push(
      before("openLazy", LazyActionSheet, (args: any[]) => {
        const [component, key, payload] = args;
        if (key !== "MessageLongPressActionSheet") return;
        if (storage.hideSetTimeButton) return; // user hid the row from settings
        const message = payload?.message;
        if (!message) return;
        component.then((instance: any) => {
          const unpatch = after("default", instance, (_: any, res: any) => {
            unpatch();
            try {
              const rows = findInReactTree(
                res,
                (n: any) => Array.isArray(n) && n.some((c: any) => c?.type?.name === "ActionSheetRow")
              );
              const template = rows?.find?.((c: any) => c?.type?.name === "ActionSheetRow");
              if (!rows || !template) return;
              rows.unshift(
                React.cloneElement(template, {
                  key: "ct-set-time",
                  label: "Set custom time",
                  subLabel: undefined,
                  onPress: () => {
                    storage.selectedMessage = {
                      id: message.id,
                      channelId: message.channel_id,
                      preview: String(message.content || "").slice(0, 40) || message.id,
                      original: safeEpoch(message.timestamp),
                    };
                    LazyActionSheet.hideActionSheet();
                    showToast("Selected — open plugin settings to set the time");
                  },
                })
              );
            } catch {}
          });
        });
      })
    );
  }

  // 3) DM LIST: make the right-side time ("19m", "15h", "1d") AND the list
  // ordering follow overrides. Both come from each channel's `lastMessageId`,
  // so we hand back a synthetic id encoding the override time. Only channels
  // whose current last message is overridden are touched; the original id is
  // tracked and restored otherwise (and on unload).
  if (ChannelStore) {
    // Channels handed out individually (row rendering, opening a DM, etc).
    if (ChannelStore.getChannel) {
      patches.push(
        after("getChannel", ChannelStore, (_args: any, channel: any) => {
          syncChannelLastMessage(channel);
          return channel;
        })
      );
    }
    // The map/array the DM list reads to sort — sync every channel so ordering
    // reflects the override even if a row never went through getChannel first.
    for (const fn of ["getSortedPrivateChannels", "getMutablePrivateChannels"]) {
      if (typeof (ChannelStore as any)[fn] !== "function") continue;
      patches.push(
        after(fn, ChannelStore, (_args: any, res: any) => {
          try {
            if (Array.isArray(res)) res.forEach(syncChannelLastMessage);
            else if (res && typeof res === "object") Object.values(res).forEach(syncChannelLastMessage);
          } catch {}
          return res;
        })
      );
    }
    // Put genuine ids back when the plugin unloads.
    patches.push(restoreAllChannels);
  }
}

export default {
  onLoad: () => setup(),
  onUnload: () => patches.forEach((u) => u()),
  settings: Settings,
};
