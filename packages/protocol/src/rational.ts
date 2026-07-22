import { assertQualifiedName } from "./identifiers.js";

export interface Rational {
  readonly numerator: string;
  readonly denominator: string;
}

export interface TimeValue {
  readonly value: Rational;
  readonly domain: string;
}

export const STANDARD_TIME_DOMAINS = {
  seconds: "org.kineweave.time/seconds",
  frames: "org.kineweave.time/frames",
  audioSamples: "org.kineweave.time/audio-samples",
  musical: "org.kineweave.time/musical",
  events: "org.kineweave.time/events"
} as const;

type IntegerInput = bigint | number | string;

function integer(value: IntegerInput, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a safe integer`);
    }
    return BigInt(value);
  }
  if (!/^-?(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a canonical base-10 integer string`);
  }
  return BigInt(value);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function rational(
  numerator: IntegerInput,
  denominator: IntegerInput = 1n
): Rational {
  let n = integer(numerator, "numerator");
  let d = integer(denominator, "denominator");
  if (d === 0n) throw new RangeError("Rational denominator cannot be zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return { numerator: "0", denominator: "1" };
  const divisor = gcd(n, d);
  return {
    numerator: (n / divisor).toString(),
    denominator: (d / divisor).toString()
  };
}

export function parseRational(value: unknown): Rational {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Rational must be an object");
  }
  const candidate = value as Partial<Rational>;
  if (
    typeof candidate.numerator !== "string" ||
    typeof candidate.denominator !== "string"
  ) {
    throw new TypeError("Rational requires string numerator and denominator");
  }
  return rational(candidate.numerator, candidate.denominator);
}

export function timeValue(value: Rational, domain: string): TimeValue {
  assertQualifiedName(domain, "time domain");
  return { value: parseRational(value), domain };
}

function sameDomain(left: TimeValue, right: TimeValue): void {
  if (left.domain !== right.domain) {
    throw new TypeError(
      `Time domain mapping required: ${left.domain} -> ${right.domain}`
    );
  }
}

export function addRational(left: Rational, right: Rational): Rational {
  return rational(
    BigInt(left.numerator) * BigInt(right.denominator) +
      BigInt(right.numerator) * BigInt(left.denominator),
    BigInt(left.denominator) * BigInt(right.denominator)
  );
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return addRational(
    left,
    rational(-BigInt(right.numerator), right.denominator)
  );
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(
    BigInt(left.numerator) * BigInt(right.numerator),
    BigInt(left.denominator) * BigInt(right.denominator)
  );
}

export function divideRational(left: Rational, right: Rational): Rational {
  const divisor = parseRational(right);
  if (BigInt(divisor.numerator) === 0n) {
    throw new RangeError("Cannot divide by zero");
  }
  return rational(
    BigInt(left.numerator) * BigInt(divisor.denominator),
    BigInt(left.denominator) * BigInt(divisor.numerator)
  );
}

export function compareRational(left: Rational, right: Rational): -1 | 0 | 1 {
  const difference =
    BigInt(left.numerator) * BigInt(right.denominator) -
    BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function addTime(left: TimeValue, right: TimeValue): TimeValue {
  sameDomain(left, right);
  return timeValue(addRational(left.value, right.value), left.domain);
}

export function compareTime(left: TimeValue, right: TimeValue): -1 | 0 | 1 {
  sameDomain(left, right);
  return compareRational(left.value, right.value);
}

export function frameIndexToSeconds(
  frameIndex: IntegerInput,
  framesPerSecond: Rational
): TimeValue {
  const rate = parseRational(framesPerSecond);
  if (BigInt(rate.numerator) <= 0n) {
    throw new RangeError("Frame rate must be positive");
  }
  return timeValue(
    rational(
      integer(frameIndex, "frame index") * BigInt(rate.denominator),
      BigInt(rate.numerator)
    ),
    STANDARD_TIME_DOMAINS.seconds
  );
}

export function rationalToNumberLossy(value: Rational): number {
  return Number(BigInt(value.numerator)) / Number(BigInt(value.denominator));
}
