import { findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { after, before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";
import { Forms } from "@vendetta/ui/components";
import { React, ReactNative } from "@vendetta/metro/common";

const { FormSection, FormRow, FormInput } = Forms;

storage.overrides ??= {}; // { [messageId]: epochMillis }
storage.hideSetTimeButton ??= false; // hide the "Set custom time" action-sheet row

const RowManager = findByName("RowManager");
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const moment = findByProps("isMoment");
const MessageStore = findByStoreName("MessageStore");
const SelectedChannelStore = findByStoreName("SelectedChannelStore");
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

function getMessagesArray(channelId: string): any[] {
  const col = MessageStore?.getMessages?.(channelId);
  if (!col) return [];
  if (typeof col.toArray === "function") return col.toArray();
  if (Array.isArray(col._array)) return col._array;
  return [];
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
  return (
    <ReactNative.ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 600 }}
      keyboardShouldPersistTaps="handled"
    >
      <FormSection title="Selected message">
        <FormRow label={sel ? sel.preview : "None — long-press a message and tap 'Set custom time'"} />
        <FormRow
          label="Deselect message"
          onPress={() => {
            try {
              delete storage.selectedMessage;
              showToast("Deselected");
            } catch {}
          }}
        />
        <FormRow
          label={
            storage.hideSetTimeButton
              ? "'Set custom time' button: Hidden (tap to show)"
              : "'Set custom time' button: Shown (tap to hide)"
          }
          subLabel="Toggles the row in the message long-press menu"
          onPress={() => {
            storage.hideSetTimeButton = !storage.hideSetTimeButton;
            showToast(storage.hideSetTimeButton ? "Button hidden" : "Button shown");
          }}
        />
      </FormSection>

      <FormSection title="Date">
        {numField("month", "Month (1-12)")}
        {numField("day", "Day")}
        {numField("year", "Year")}
      </FormSection>

      <FormSection title="Time">
        {numField("hour", "Hour (1-12)")}
        {numField("minute", "Minute")}
        <FormRow
          label={f.pm ? "PM  (tap to switch to AM)" : "AM  (tap to switch to PM)"}
          onPress={() => up("pm", !f.pm)}
        />
        <FormRow label="Save for selected message" onPress={saveOne} />
      </FormSection>

      <FormSection title="Auto-sequence a DM">
        <FormInput
          title="Channel ID (optional — blank = current DM)"
          value={friendId}
          keyboardType="numeric"
          onChange={(v: string) => { storage.channelId = v; }}
          onChangeText={(v: string) => { storage.channelId = v; }}
        />
        <FormInput
          title="Times, oldest first (one per line or comma-separated)"
          placeholder="Yesterday at 2:30 AM, 5:30 AM, 2:23 PM, 5:34 PM"
          value={seq}
          multiline={true}
          onChange={(v: string) => { storage.seqText = v; }}
          onChangeText={(v: string) => { storage.seqText = v; }}
        />
        <FormRow label="Apply sequence to DM" onPress={applySequence} />
      </FormSection>

      <FormSection title="Auto-distance blocks (uses Channel ID above)">
        <FormInput
          title="Start time (first block)"
          placeholder="Yesterday 8:30 PM"
          value={storage.distStart ?? ""}
          onChange={(v: string) => { storage.distStart = v; }}
          onChangeText={(v: string) => { storage.distStart = v; }}
        />
        <FormInput
          title="Distance apart (4-7h, 30-90m, 45m, 5h…)"
          placeholder="4-7"
          value={storage.distRange ?? ""}
          onChange={(v: string) => { storage.distRange = v; }}
          onChangeText={(v: string) => { storage.distRange = v; }}
        />
        <FormRow label="Auto-distance blocks" onPress={applyDistance} />
      </FormSection>

      <FormSection title="Current overrides (tap to remove)">
        <FormRow
          label="Clear ALL overrides"
          onPress={() => { storage.overrides = {}; showToast("Cleared all overrides"); }}
        />
        {Object.keys(ovr).length === 0
          ? <FormRow label="None yet" />
          : Object.keys(ovr).map((id) => (
              <FormRow
                label={formatStamp(ovr[id])}
                subLabel={id}
                onPress={() => { delete storage.overrides[id]; showToast("Removed"); }}
              />
            ))}
      </FormSection>
    </ReactNative.ScrollView>
  );
}

// ---------------- Patches ----------------
function setup() {
  // 1) DISPLAY: replace the rendered timestamp for overridden messages
  if (RowManager?.prototype?.generate) {
    patches.push(
      after("generate", RowManager.prototype, ([data]: any, row: any) => {
        try {
          const id = row?.message?.id;
          if (!id || storage.overrides[id] == null) return;
          const custom = storage.overrides[id];
          const ts = row.message.timestamp;
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
          // Replace the message on this throwaway render row with a shallow copy so
          // we never mutate Discord's stored message (keeps overrides reversible).
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

  // 3) DM LIST: the short relative time ("1m", "1h", "1d") on each DM row is
  // derived from the last message's snowflake (the message id encodes a time).
  // Make snowflake -> time honor overrides, so the list matches the last
  // message's displayed time whether it was spoofed or not. Only ids that are
  // actually overridden are affected; everything else passes through untouched.
  const SnowflakeUtils = findByProps("extractTimestamp", "fromTimestamp");
  if (SnowflakeUtils?.extractTimestamp) {
    patches.push(
      after("extractTimestamp", SnowflakeUtils, ([id]: any, res: any) => {
        try {
          if (id != null && storage.overrides[id] != null) {
            const ov = storage.overrides[id];
            return res instanceof Date ? new Date(ov) : ov;
          }
        } catch {}
        return res;
      })
    );
  }
}

export default {
  onLoad: () => setup(),
  onUnload: () => patches.forEach((u) => u()),
  settings: Settings,
};
