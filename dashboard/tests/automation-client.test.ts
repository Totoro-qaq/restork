import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../src/api/client";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalApiClient automation lifecycle", () => {
  it("uses the human schedule contract and opaque cursors without exposing technical IDs on create", async () => {
    const schedule = {
      schedule_id: "schedule-generated",
      schedule: {
        schedule_id: "schedule-generated",
        name: "Morning local check",
        timezone: "Asia/Shanghai",
        recurrence: { kind: "daily", hour: 9, minute: 5 },
        missed_run_policy: "create_draft",
        job: { kind: "deterministic", job: "health.check" },
      },
      revision: 1,
      state: "active",
      next_run_at: "2026-08-10T01:05:00Z",
      updated_at: "2026-08-09T03:00:00Z",
      deleted_at: null,
    };
    const page = { limit: 20, has_more: false, next_cursor: null };
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse(schedule, 201),
      jsonResponse({ ...schedule, revision: 2 }),
      jsonResponse({ items: [schedule], page }),
      jsonResponse({ items: [{ ...schedule, deleted_at: "2026-08-09T04:00:00Z" }], page }),
      jsonResponse({ ...schedule, revision: 3 }),
      jsonResponse({
        items: [{
          schedule_id: schedule.schedule_id,
          period_key: "manual:fixture",
          run_id: null,
          result: { state: "completed", job: "health.check", manual: true },
          created_at: "2026-08-09T03:30:00Z",
          replayed: false,
        }],
        page,
      }),
      new Response(null, { status: 204 }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();
    await client.pair("pairing-code");

    const input = {
      name: "Morning local check",
      timezone: "Asia/Shanghai",
      recurrence: { kind: "daily" as const, hour: 9, minute: 5 },
      missed_run_policy: "create_draft" as const,
      job: { kind: "deterministic" as const, job: "health.check" as const },
    };
    await client.createSchedule(input);
    await client.updateSchedule("schedule-generated", 1, {
      ...input,
      schedule_id: "schedule-generated",
      name: "Morning health check",
    });
    await client.listSchedules("active-page");
    await client.listDeletedSchedules("trash-page");
    await client.restoreSchedule("schedule-generated", 2);
    await client.listScheduleRuns("schedule-generated", "runs-page");
    await client.deleteSchedule("schedule-generated", 3);

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/schedules");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(input);
    expect(String(fetchMock.mock.calls[1][1]?.body)).not.toContain("schedule_id");
    expect(fetchMock.mock.calls[2][0]).toBe("/v1/schedules/schedule-generated");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      expected_revision: 1,
      schedule: expect.objectContaining({
        schedule_id: "schedule-generated",
        name: "Morning health check",
      }),
    });
    expect(fetchMock.mock.calls[3][0]).toBe("/v1/schedules?limit=20&cursor=active-page");
    expect(fetchMock.mock.calls[4][0]).toBe("/v1/schedules/deleted?limit=20&cursor=trash-page");
    expect(fetchMock.mock.calls[5][0]).toBe("/v1/schedules/schedule-generated/restore");
    expect(fetchMock.mock.calls[6][0]).toBe(
      "/v1/schedules/schedule-generated/runs?limit=20&cursor=runs-page",
    );
    expect(fetchMock.mock.calls[7][1]?.method).toBe("DELETE");
  });
});
