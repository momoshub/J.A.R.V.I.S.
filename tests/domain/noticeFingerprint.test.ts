import { describe, expect, test } from "bun:test";
import { legacyNoticeFingerprint, noticeFingerprint, sameNotice } from "../../src/domain/noticeFingerprint.ts";

const LINK = "<https://example.slack.com/archives/D1/p1700000000000100?thread_ts=1700000000.000100&cid=D1|the thread>";

const notice = (text: string): unknown[] => [
  { type: "section", text: { type: "mrkdwn", text } },
  {
    type: "actions",
    elements: [{ type: "button", action_id: "approve", text: { type: "plain_text", text: "Approve" }, value: "47" }],
  },
];

describe("noticeFingerprint", () => {
  test("a notice with a thread permalink matches as Slack echoes it, & escaped to &amp;", () => {
    const sent = notice(`> fact\nProposed in ${LINK}`);
    const echoed = notice(`&gt; fact\nProposed in ${LINK.replace("&", "&amp;")}`);
    expect(noticeFingerprint(echoed)).toBe(noticeFingerprint(sent));
  });

  test("unescaping is one pass: &amp;gt; is a literal &gt;, not a quote marker", () => {
    expect(noticeFingerprint(notice("&amp;gt; fact"))).not.toBe(noticeFingerprint(notice("> fact")));
  });

  test("a < is never softened: an escaped link differs from a live one", () => {
    expect(noticeFingerprint(notice("&lt;https://x.test|x&gt;"))).not.toBe(noticeFingerprint(notice("<https://x.test|x>")));
  });

  test("a changed link or button still differs", () => {
    const sent = notice(`Proposed in ${LINK}`);
    expect(noticeFingerprint(notice(`Proposed in ${LINK.replace("cid=D1", "cid=D2")}`))).not.toBe(noticeFingerprint(sent));
  });

  test("a notice stored before the change, with & in its text, still matches its echo", () => {
    const sent = notice("> Deploys need QA &amp; PM sign-off first");
    const stored = legacyNoticeFingerprint(sent);
    expect(noticeFingerprint(sent)).not.toBe(stored);
    expect(sameNotice(sent, stored)).toBe(true);
    expect(sameNotice(notice("> Deploys need QA &amp; PM sign-off later"), stored)).toBe(false);
  });

  test("an empty stored fingerprint never matches", () => {
    expect(sameNotice(notice("x"), "")).toBe(false);
  });
});
