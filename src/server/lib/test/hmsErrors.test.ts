import { describe, it, expect } from "vitest";
import {
  describeHmsErrors,
  hmsAttentionLevel,
  isOperationalHmsError,
} from "../hmsErrors";

describe("hmsErrors", () => {
  it("treats filament run-out as operational", () => {
    expect(
      isOperationalHmsError(
        'The filament ran out. Please load new filament and select "Resume" to resume the print job.',
      ),
    ).toBe(true);
  });

  it("treats hardware faults as errors", () => {
    expect(isOperationalHmsError("The nozzle is clogged.")).toBe(false);
    expect(
      isOperationalHmsError("Z axis homing failed; the task has been stopped."),
    ).toBe(false);
  });

  it("builds a Bambu wiki link and flags unknown codes as errors", () => {
    const [e] = describeHmsErrors([{ code: "00010005", attr: 0x03004000 }]);
    expect(e.wikiUrl).toBe("https://e.bambulab.com/?e=0300400000010005");
    expect(e.operational).toBe(false);
    expect(hmsAttentionLevel([e])).toBe("error");
    expect(hmsAttentionLevel([{ operational: true }])).toBe("warning");
    expect(hmsAttentionLevel([])).toBe("error");
  });
});
