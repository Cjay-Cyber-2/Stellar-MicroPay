import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import BatchPaymentForm from "@/components/BatchPaymentForm";

const mockSubmitTransaction = jest.fn(() => Promise.resolve({ hash: "tx-abc123" }));

jest.mock("@/lib/stellar", () => ({
  isValidStellarAddress: jest.fn(
    (addr: string) => typeof addr === "string" && addr.startsWith("G") && addr.length === 56
  ),
  buildPaymentTransaction: jest.fn(() =>
    Promise.resolve({ toXDR: () => "mocked-xdr" })
  ),
  submitTransaction: (...args: unknown[]) => mockSubmitTransaction(...args),
  STELLAR_MEMO_TEXT_MAX_BYTES: 28,
  STELLAR_MINIMUM_ACCOUNT_BALANCE_XLM: 1,
  truncateMemoText: jest.fn((text: string) => text),
}));

jest.mock("@/lib/wallet", () => ({
  signTransactionWithWallet: jest.fn(() =>
    Promise.resolve({ signedXDR: "signed-xdr", error: null })
  ),
}));

const OWN_KEY    = "GOWN1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234";
const VALID_ADDR = "GDEST234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234";
const VALID_ADDR_2 = "GSECOND34567890ABCDEF1234567890ABCDEF1234567890ABCDEF123";

const defaultProps = {
  publicKey: OWN_KEY,
  xlmBalance: "100",
  onBatchSuccess: jest.fn(),
};

describe("BatchPaymentForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders with a single empty recipient row by default", () => {
    render(<BatchPaymentForm {...defaultProps} />);

    expect(screen.getAllByPlaceholderText("G...")).toHaveLength(1);
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  it("adds a new recipient row when Add recipient is clicked", async () => {
    const user = userEvent.setup();
    render(<BatchPaymentForm {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /Add recipient/i }));

    expect(screen.getAllByPlaceholderText("G...")).toHaveLength(2);
    expect(screen.getByText("2 / 10")).toBeInTheDocument();
  });

  it("removes a recipient row when Remove is clicked", async () => {
    const user = userEvent.setup();
    render(<BatchPaymentForm {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /Add recipient/i }));
    expect(screen.getAllByPlaceholderText("G...")).toHaveLength(2);

    const removeButtons = screen.getAllByRole("button", { name: /Remove/i });
    await user.click(removeButtons[0]);

    expect(screen.getAllByPlaceholderText("G...")).toHaveLength(1);
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  it("Send batch button is disabled when no row has a valid address and amount", () => {
    render(<BatchPaymentForm {...defaultProps} />);
    expect(screen.getByRole("button", { name: /Send batch/i })).toBeDisabled();
  });

  it("Send batch button is enabled once a row has a valid address and positive amount", async () => {
    const user = userEvent.setup();
    render(<BatchPaymentForm {...defaultProps} />);

    await user.type(screen.getByPlaceholderText("G..."), VALID_ADDR);
    await user.type(screen.getByPlaceholderText("0.5"), "2");

    expect(screen.getByRole("button", { name: /Send batch/i })).not.toBeDisabled();
  });

  it("computes the total amount correctly across multiple rows", async () => {
    const user = userEvent.setup();
    render(<BatchPaymentForm {...defaultProps} />);

    await user.type(screen.getAllByPlaceholderText("0.5")[0], "2.5");
    await user.click(screen.getByRole("button", { name: /Add recipient/i }));
    await user.type(screen.getAllByPlaceholderText("0.5")[1], "7.5");

    expect(screen.getByText(/10\.0000000 XLM/)).toBeInTheDocument();
  });

  it("shows inline validation error for an invalid Stellar address after batch submit", async () => {
    const user = userEvent.setup();
    render(<BatchPaymentForm {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /Add recipient/i }));
    const addressInputs = screen.getAllByPlaceholderText("G...");
    const amountInputs  = screen.getAllByPlaceholderText("0.5");

    await user.type(addressInputs[1], VALID_ADDR);
    await user.type(amountInputs[1], "1");

    await user.type(addressInputs[0], "INVALID_ADDRESS");
    await user.type(amountInputs[0], "1");

    await user.click(screen.getByRole("button", { name: /Send batch/i }));

    await waitFor(() => {
      expect(screen.getByText(/Invalid Stellar address/i)).toBeInTheDocument();
    });
  });

  it("shows inline validation error when amount is zero or missing", async () => {
    const user = userEvent.setup();
    render(<BatchPaymentForm {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /Add recipient/i }));
    const addressInputs = screen.getAllByPlaceholderText("G...");
    const amountInputs  = screen.getAllByPlaceholderText("0.5");

    await user.type(addressInputs[1], VALID_ADDR);
    await user.type(amountInputs[1], "1");

    await user.type(addressInputs[0], VALID_ADDR);

    await user.click(screen.getByRole(	ext, { name: /Send batch/i }));

    await waitFor(() => {
      expect(screen.getByText(/Amount must be greater than 0/i)).toBeInTheDocument();
    });
  });

  it("records per-chunk hashes and allows retrying only failed operations without duplicating success", async () => {
    const user = userEvent.setup();
    mockSubmitTransaction
      .mockResolvedValueOnce({ hash: "hash-first-success" })
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValueOnce({ hash: "hash-retry-success" });

    render(<BatchPaymentForm {...defaultProps} />);

    // Add two more rows (3 total)
    await user.click(screen.getByRole("button", { name: /Add recipient/i }));
    await user.click(screen.getByRole("button", { name: /Add recipient/i }));

    const addressInputs = screen.getAllByPlaceholderText("G...");
    const amountInputs  = screen.getAllByPlaceholderText("0.5");

    await user.type(addressInputs[0], VALID_ADDR);
    await user.type(amountInputs[0], "1");

    await user.type(addressInputs[1], VALID_ADDR_2);
    await user.type(amountInputs[1], "2");

    await user.type(addressInputs[2], VALID_ADDR);
    await user.type(amountInputs[2], "3");

    await user.click(screen.getByRole("button", { name: /Send batch/i }));

    await waitFor(() => {
      expect(screen.getByText(/Partial batch result/i)).toBeInTheDocument();
    });

    // First and third succeed, second failed
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);

    // Click 'Retry failed only'
    const retryButton = screen.getByRole("button", { name: /Retry failed only/i });
    await user.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText(/Successfully sent batch/i)).toBeInTheDocument();
    });

    // Only the failed row was re-submitted (total 3 submit calls)
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(3);
  });
});
