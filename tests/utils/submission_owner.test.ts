import { describe, expect, it } from "vitest";
import { SubmissionOwner } from "../../src/utils/submission_owner";

/** Submission ownership is source-scoped, latest-start wins, and consumed once. */
describe("SubmissionOwner", () => {
  const dispatch = (source: EventTarget, detail?: unknown): Event => {
    const event = new CustomEvent("submission", { detail });
    source.dispatchEvent(event);
    return event;
  };

  it("ignores terminals without an owner and after ownership is cleared", () => {
    const owner = new SubmissionOwner();
    const source = new EventTarget();
    expect(owner.resolve(dispatch(source, { success: true }))).toBeNull();
    owner.begin(dispatch(source));
    owner.clear();
    expect(owner.resolve(dispatch(source, { success: true }))).toBeNull();
  });

  it.each([true, false, undefined, null, 1, "true"])(
    "consumes a matching terminal once with success %s",
    (success) => {
      const owner = new SubmissionOwner();
      const source = new EventTarget();
      const formSubmission = {};
      owner.begin(dispatch(source, { formSubmission }));
      expect(owner.resolve(dispatch(source, { formSubmission, success }))).toBe(success === true);
      expect(owner.resolve(dispatch(source, { formSubmission, success: false }))).toBeNull();
    },
  );

  it.each([false, true])(
    "only resolves the newest start, with old terminal first: %s",
    (oldFirst) => {
      const owner = new SubmissionOwner();
      const source = new EventTarget();
      const first = {};
      const second = {};
      owner.begin(dispatch(source, { formSubmission: first }));
      owner.begin(dispatch(source, { formSubmission: second }));
      if (oldFirst) expect(owner.resolve(dispatch(source, { formSubmission: first }))).toBeNull();
      expect(owner.resolve(dispatch(source, { formSubmission: second, success: true }))).toBe(true);
      expect(owner.resolve(dispatch(source, { formSubmission: first, success: false }))).toBeNull();
    },
  );

  it.each([undefined, null, {}])(
    "rejects a different source even for the same token %s",
    (token) => {
      const owner = new SubmissionOwner();
      const first = new EventTarget();
      const second = new EventTarget();
      owner.begin(dispatch(first, { formSubmission: token }));
      expect(owner.resolve(dispatch(second, { formSubmission: token, success: true }))).toBeNull();
      expect(owner.resolve(dispatch(first, { formSubmission: token, success: false }))).toBe(false);
    },
  );

  it.each([undefined, null])("pairs unnamed and null synthetic tokens %s", (token) => {
    const owner = new SubmissionOwner();
    const source = new EventTarget();
    owner.begin(dispatch(source, { formSubmission: token }));
    expect(
      owner.resolve(
        dispatch(source, { formSubmission: token === null ? undefined : null, success: true }),
      ),
    ).toBe(true);
  });

  it.each([false, true])(
    "keeps named and synthetic lifecycles separate, synthetic start: %s",
    (synthetic) => {
      const owner = new SubmissionOwner();
      const source = new EventTarget();
      const token = {};
      owner.begin(dispatch(source, { formSubmission: synthetic ? null : token }));
      expect(
        owner.resolve(
          dispatch(source, { formSubmission: synthetic ? token : null, success: true }),
        ),
      ).toBeNull();
      expect(
        owner.resolve(
          dispatch(source, { formSubmission: synthetic ? undefined : token, success: true }),
        ),
      ).toBe(true);
    },
  );

  it("accepts plain events and absent detail as synthetic failures", () => {
    const owner = new SubmissionOwner();
    const source = new EventTarget();
    const start = new Event("start");
    source.dispatchEvent(start);
    owner.begin(start);
    expect(owner.resolve(dispatch(source))).toBe(false);
  });

  it.each([false, 0, ""])("preserves a non-null falsy token %s", (formSubmission) => {
    const owner = new SubmissionOwner();
    const source = new EventTarget();
    owner.begin(dispatch(source, { formSubmission }));
    expect(owner.resolve(dispatch(source, { success: true }))).toBeNull();
    expect(owner.resolve(dispatch(source, { formSubmission, success: true }))).toBe(true);
  });
});
