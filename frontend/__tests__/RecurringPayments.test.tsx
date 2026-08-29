import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import RecurringPayments, { migrateSchedules, CURRENT_RECURRING_SCHEMA_VERSION } from "@/components/RecurringPayments";

const RECIPIENT = "GDEST234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567";

function renderRP(onPayNow = jest.fn()) {
  return render(<RecurringPayments onPayNow={onPayNow} />);
}

beforeEach(() => {
  localStorage.clear();
});

describe("RecurringPayments — schema versioning & migration", () => {
  it("migrates legacy unversioned schedules to schema v2 with default paused state", () => {
    const legacy = [
      {
        id: "sched-1",
        recipient: RECIPIENT,
        amount: "10",
        memo: "monthly rent",
        frequency: "monthly",
        startDate: "2026-01-01",
        nextDueDate: "2026-02-01",
        createdAt: 1700000000000,
      },
    ];

    const migrated = migrateSchedules(legacy);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].schemaVersion).toBe(CURRENT_RECURRING_SCHEMA_VERSION);
    expect(migrated[0].paused).toBe(false);
    expect(migrated[0].pausedAt).toBeNull();
  });

  it("migrates legacy paused schedules correctly", () => {
    const legacyPaused = [
      {
        id: "sched-2",
        recipient: RECIPIENT,
        amount: "25",
        memo: "",
        frequency: "weekly",
        startDate: "2026-03-01",
        nextDueDate: "2026-03-08",
        createdAt: 1700000000000,
        paused: true,
      },
    ];

    const migrated = migrateSchedules(legacyPaused);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].schemaVersion).toBe(CURRENT_RECURRING_SCHEMA_VERSION);
    expect(migrated[0].paused).toBe(true);
    expect(typeof migrated[0].pausedAt).toBe("number");
  });

  it("rejects schedules with impossible or zero/negative amounts", () => {
    const badSchedules = [
      {
        id: "bad-1",
        recipient: RECIPIENT,
        amount: "-10",
        frequency: "monthly",
        startDate: "2026-01-01",
        nextDueDate: "2026-02-01",
        createdAt: 1700000000000,
      },
      {
        id: "bad-2",
        recipient: RECIPIENT,
        amount: "0",
        frequency: "monthly",
        startDate: "2026-01-01",
        nextDueDate: "2026-02-01",
        createdAt: 1700000000000,
      },
      {
        id: "bad-3",
        recipient: RECIPIENT,
        amount: "not-a-number",
        frequency: "monthly",
        startDate: "2026-01-01",
        nextDueDate: "2026-02-01",
        createdAt: 1700000000000,
      },
    ];

    const migrated = migrateSchedules(badSchedules);
    expect(migrated).toHaveLength(0);
  });

  it("rejects schedules with invalid frequency cadence", () => {
    const badCadence = [
      {
        id: "bad-cadence",
        recipient: RECIPIENT,
        amount: "10",
        frequency: "daily",
        startDate: "2026-01-01",
        nextDueDate: "2026-01-02",
        createdAt: 1700000000000,
      },
    ];

    const migrated = migrateSchedules(badCadence);
    expect(migrated).toHaveLength(0);
  });
});

describe("RecurringPayments — schedule creation (#513)", () => {
  it("shows an empty state message when no schedules exist", () => {
    renderRP();
    expect(screen.getByText(/No recurring schedules yet/i)).toBeInTheDocument();
  });

  it("opens the new-schedule form when '+ New schedule' is clicked", async () => {
    const user = userEvent.setup();
    renderRP();

    await user.click(screen.getByText(/\+ New schedule/i));

    expect(screen.getByText(/New recurring payment/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create/i })).toBeInTheDocument();
  });

  it("creates a new schedule with a valid recipient and amount", async () => {
    const user = userEvent.setup();
    renderRP();

    await user.click(screen.getByText(/\+ New schedule/i));

    await user.type(screen.getByPlaceholderText("G..."), RECIPIENT);
    await user.clear(screen.getByPlaceholderText("0.0000000"));
    await user.type(screen.getByPlaceholderText("0.0000000"), "5");

    await user.click(screen.getByRole("button", { name: /Create/i }));

    expect(screen.getByText(/5 XLM/i)).toBeInTheDocument();
    expect(screen.queryByText(/No recurring schedules yet/i)).not.toBeInTheDocument();
  });

  it("creates a weekly schedule and shows the frequency label", async () => {
    const user = userEvent.setup();
    renderRP();

    await user.click(screen.getByText(/\+ New schedule/i));

    await user.type(screen.getByPlaceholderText("G..."), RECIPIENT);
    await user.clear(screen.getByPlaceholderText("0.0000000"));
    await user.type(screen.getByPlaceholderText("0.0000000"), "2");
    await user.selectOptions(screen.getByRole("combobox"), "weekly");

    await user.click(screen.getByRole("button", { name: /Create/i }));

    expect(screen.getByText(/weekly/i)).toBeInTheDocument();
  });

  it("rejects submission when recipient is missing and shows an error", async () => {
    const user = userEvent.setup();
    renderRP();

    await user.click(screen.getByText(/\+ New schedule/i));

    await user.clear(screen.getByPlaceholderText("0.0000000"));
    await user.type(screen.getByPlaceholderText("0.0000000"), "3");
    await user.click(screen.getByRole("button", { name: /Create/i }));

    expect(screen.getByText(/Recipient is required/i)).toBeInTheDocument();
  });

  it("rejects submission when amount is zero or invalid and shows an error", async () => {
    const user = userEvent.setup();
    renderRP();

    await user.click(screen.getByText(/\+ New schedule/i));

    await user.type(screen.getByPlaceholderText("G..."), RECIPIENT);
    await user.click(screen.getByRole("button", { name: /Create/i }));

    expect(screen.getByText(/Enter a valid amount/i)).toBeInTheDocument();
  });

  it("dismisses the form when Cancel is clicked", async () => {
    const user = userEvent.setup();
    renderRP();

    await user.click(screen.getByText(/\+ New schedule/i));
    expect(screen.getByText(/New recurring payment/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByText(/New recurring payment/i)).not.toBeInTheDocument();
  });
});

describe("RecurringPayments — listing existing schedules (#513)", () => {
  it("lists multiple schedules after creation", async () => {
    const user = userEvent.setup();
    renderRP();

    for (const amount of ["1", "2"]) {
      await user.click(screen.getByText(/\+ New schedule/i));
      await user.type(screen.getByPlaceholderText("G..."), RECIPIENT);
      await user.clear(screen.getByPlaceholderText("0.0000000"));
      await user.type(screen.getByPlaceholderText("0.0000000"), amount);
      await user.click(screen.getByRole("button", { name: /Create/i }));
    }

    expect(screen.getByText(/1 XLM/i)).toBeInTheDocument();
    expect(screen.getByText(/2 XLM/i)).toBeInTheDocument();
  });

  it("persists schedules to localStorage so they survive a re-render", async () => {
    const user = userEvent.setup();
    const { unmount } = renderRP();

    await user.click(screen.getByText(/\+ New schedule/i));
    await user.type(screen.getByPlaceholderText("G..."), RECIPIENT);
    await user.clear(screen.getByPlaceholderText("0.0000000"));
    await user.type(screen.getByPlaceholderText("0.0000000"), "9");
    await user.click(screen.getByRole("button", { name: /Create/i }));
    unmount();

    renderRP();
    expect(screen.getByText(/9 XLM/i)).toBeInTheDocument();
  });
});

describe("RecurringPayments — pause / delete actions (#513)", () => {
  async function createSchedule(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByText(/\+ New schedule/i));
    await user.type(screen.getByPlaceholderText("G..."), RECIPIENT);
    await user.clear(screen.getByPlaceholderText("0.0000000"));
    await user.type(screen.getByPlaceholderText("0.0000000"), "3");
    await user.click(screen.getByRole("button", { name: /Create/i }));
  }

  it("pauses a schedule when the Pause button is clicked", async () => {
    const user = userEvent.setup();
    renderRP();
    await createSchedule(user);

    await user.click(screen.getByRole("button", { name: /Pause schedule/i }));

    expect(screen.getByText(/Paused/i)).toBeInTheDocument();
  });

  it("resumes a paused schedule when the Play button is clicked", async () => {
    const user = userEvent.setup();
    renderRP();
    await createSchedule(user);

    await user.click(screen.getByRole("button", { name: /Pause schedule/i }));
    expect(screen.getByText(/Paused/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Resume schedule/i }));
    expect(screen.queryByText(/Paused/i)).not.toBeInTheDocument();
  });

  it("removes a schedule when the Delete button is clicked", async () => {
    const user = userEvent.setup();
    renderRP();
    await createSchedule(user);

    expect(screen.getByText(/3 XLM/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Delete schedule/i }));

    expect(screen.queryByText(/3 XLM/i)).not.toBeInTheDocument();
  });
});
