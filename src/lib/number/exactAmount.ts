/**
 * 큰 수(임의 정밀도) 처리 모듈 — 2DStock에서 검증된 로직을 CivilStock으로 이식.
 *
 * 국가 재정·GDP·통화 발행량은 2^53(Number.MAX_SAFE_INTEGER)을 쉽게 넘고,
 * Firestore/JSON은 BigInt를 직렬화하지 못한다. 그래서 저장 형식은 항상
 * **정수 문자열**이고, 연산하는 짧은 순간에만 BigInt로 변환한다.
 *
 * - 저장/전송(Firestore 필드, 함수 payload): string
 * - 연산(Cloud Function / 클라이언트): BigInt
 * - 화면 표시: format* 함수
 *
 * 통화의 최소 단위는 정수(예: 2DStock의 "센트")로 두고, 소수는 절대 float로
 * 굴리지 않는다. 이 규율만 지키면 서버·클라이언트가 완전히 동일한 결과를 낸다.
 */
export type ExactAmount = string;

const DECIMAL_PATTERN =
  /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

function pow10(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 10_000) {
    throw new RangeError("exact amount exponent is outside the supported range");
  }
  return 10n ** BigInt(exponent);
}

function parseDecimal(value: string): {
  negative: boolean;
  digits: string;
  decimalPlaces: number;
  exponent: number;
} | null {
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) return null;
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    return null;
  }
  return {
    negative: match[1] === "-",
    digits,
    decimalPlaces: fraction.length,
    exponent,
  };
}

/** 10진수/지수 표기 문자열을 지정 소수 자릿수의 정수로 반올림한다. */
export function decimalToScaledInteger(
  value: string | number | bigint,
  scale: number,
): bigint {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 12) {
    throw new RangeError("invalid decimal scale");
  }
  if (typeof value === "bigint") return value * pow10(scale);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError("non-finite exact amount");
  }
  const parsed = parseDecimal(String(value));
  if (!parsed) throw new TypeError("invalid decimal value");

  const shift = parsed.exponent - parsed.decimalPlaces + scale;
  let magnitude = BigInt(parsed.digits);
  if (shift >= 0) {
    magnitude *= pow10(shift);
  } else {
    const divisor = pow10(-shift);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  return parsed.negative && magnitude !== 0n ? -magnitude : magnitude;
}

export function normalizeExactAmount(
  value: unknown,
  fallback: ExactAmount = "0",
): ExactAmount {
  try {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return normalizeExactAmount(fallback, "0");
      // BigInt(number)는 현재 IEEE-754 값이 나타내는 정수를 그대로 옮긴다.
      return BigInt(Math.round(value)).toString();
    }
    if (typeof value === "string" && value.trim()) {
      return decimalToScaledInteger(value, 0).toString();
    }
  } catch {
    // 아래 fallback 처리로 이어진다.
  }
  if (fallback === value) return "0";
  return normalizeExactAmount(fallback, "0");
}

export function exactAmountFromNumber(value: number): ExactAmount {
  return normalizeExactAmount(value);
}

export function exactAdd(left: unknown, right: unknown): ExactAmount {
  return (
    BigInt(normalizeExactAmount(left)) + BigInt(normalizeExactAmount(right))
  ).toString();
}

export function exactSubtract(left: unknown, right: unknown): ExactAmount {
  return (
    BigInt(normalizeExactAmount(left)) - BigInt(normalizeExactAmount(right))
  ).toString();
}

export function exactNegate(value: unknown): ExactAmount {
  return (-BigInt(normalizeExactAmount(value))).toString();
}

export function exactCompare(left: unknown, right: unknown): -1 | 0 | 1 {
  const a = BigInt(normalizeExactAmount(left));
  const b = BigInt(normalizeExactAmount(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function exactAbs(value: unknown): ExactAmount {
  const amount = BigInt(normalizeExactAmount(value));
  return (amount < 0n ? -amount : amount).toString();
}

export function exactToNumber(value: unknown): number {
  const parsed = Number(normalizeExactAmount(value));
  if (Number.isFinite(parsed)) return parsed;
  return parsed < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

export function normalizeExactQuantity(value: unknown, fallback = "0"): string {
  try {
    const scaled = decimalToScaledInteger(
      typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "bigint"
        ? value
        : fallback,
      6,
    );
    const negative = scaled < 0n;
    const abs = negative ? -scaled : scaled;
    const integer = abs / 1_000_000n;
    const fraction = (abs % 1_000_000n)
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "");
    const text = fraction ? `${integer}.${fraction}` : integer.toString();
    return negative && abs !== 0n ? `-${text}` : text;
  } catch {
    if (fallback === value) return "0";
    return normalizeExactQuantity(fallback, "0");
  }
}

export function exactQuantityAdd(left: unknown, right: unknown): string {
  const sum =
    decimalToScaledInteger(normalizeExactQuantity(left), 6) +
    decimalToScaledInteger(normalizeExactQuantity(right), 6);
  return normalizeExactQuantity(
    `${sum < 0n ? "-" : ""}${(sum < 0n ? -sum : sum) / 1_000_000n}.${
      ((sum < 0n ? -sum : sum) % 1_000_000n).toString().padStart(6, "0")
    }`,
  );
}

export function exactQuantityMultiply(left: unknown, right: unknown): string {
  const product =
    decimalToScaledInteger(normalizeExactQuantity(left), 6) *
    decimalToScaledInteger(
      typeof right === "string" ||
        typeof right === "number" ||
        typeof right === "bigint"
        ? right
        : "0",
      6,
    );
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = abs / 1_000_000n + (abs % 1_000_000n >= 500_000n ? 1n : 0n);
  const signed = negative ? -rounded : rounded;
  const signedAbs = signed < 0n ? -signed : signed;
  return normalizeExactQuantity(
    `${signed < 0n ? "-" : ""}${signedAbs / 1_000_000n}.${
      (signedAbs % 1_000_000n).toString().padStart(6, "0")
    }`,
  );
}

/** 정수 최소단위 가격 × 최대 6자리 소수 수량을 정수 단위로 반올림한다. */
export function exactPositionValue(
  priceMinorUnit: string | number | bigint,
  quantity: unknown,
): ExactAmount {
  const price = BigInt(normalizeExactAmount(priceMinorUnit));
  const micros = decimalToScaledInteger(normalizeExactQuantity(quantity), 6);
  const product = price * micros;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = abs / 1_000_000n + (abs % 1_000_000n >= 500_000n ? 1n : 0n);
  return (negative ? -rounded : rounded).toString();
}

/** (current - baseline) / baseline × 100을 지정 자릿수의 10진 문자열로 계산한다. */
export function exactPercentChange(
  current: unknown,
  baseline: unknown,
  fractionDigits = 8,
): string {
  const now = BigInt(normalizeExactAmount(current));
  const base = BigInt(normalizeExactAmount(baseline));
  if (base === 0n) return "0";
  const scale = pow10(fractionDigits);
  const numerator = (now - base) * 100n * scale;
  const negative = (numerator < 0n) !== (base < 0n);
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absBase = base < 0n ? -base : base;
  let scaled = absNumerator / absBase;
  if ((absNumerator % absBase) * 2n >= absBase) scaled += 1n;
  const integer = scaled / scale;
  const fraction = (scaled % scale)
    .toString()
    .padStart(fractionDigits, "0")
    .replace(/0+$/, "");
  const text = fraction ? `${integer}.${fraction}` : integer.toString();
  return negative && scaled !== 0n ? `-${text}` : text;
}

const COMPACT_EXACT_UNITS = [
  { suffix: "Dc", exponent: 33 },
  { suffix: "No", exponent: 30 },
  { suffix: "Oc", exponent: 27 },
  { suffix: "Sp", exponent: 24 },
  { suffix: "Sx", exponent: 21 },
  { suffix: "Qi", exponent: 18 },
  { suffix: "Qa", exponent: 15 },
  { suffix: "T", exponent: 12 },
  { suffix: "B", exponent: 9 },
  { suffix: "M", exponent: 6 },
] as const;

function commaInteger(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatScaledHundredths(absMinor: bigint, exponent: number): string {
  const divisor = pow10(exponent + 2);
  let hundredths = (absMinor * 100n) / divisor;
  if (((absMinor * 100n) % divisor) * 2n >= divisor) hundredths += 1n;
  const whole = hundredths / 100n;
  const decimal = (hundredths % 100n).toString().padStart(2, "0");
  const digits = whole >= 100n ? 0 : whole >= 10n ? 1 : 2;
  return digits === 0
    ? whole.toString()
    : `${whole}.${decimal.slice(0, digits)}`;
}

/**
 * number 변환 없이 임의 크기 정수(최소단위 2자리)를 화면용 금액으로 표시한다.
 * `symbol`로 통화 기호를 바꿀 수 있다(국가별 통화 대응). 기본값은 "$".
 */
export function formatExactMoney(value: unknown, symbol = "$"): string {
  const amount = BigInt(normalizeExactAmount(value));
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const sign = negative ? "-" : "";
  const major = abs / 100n;
  const minor = (abs % 100n).toString().padStart(2, "0");

  if (major < 1_000_000n) {
    return `${sign}${symbol}${commaInteger(major)}.${minor}`;
  }

  const majorDigits = major.toString().length;
  const majorExponent = majorDigits - 1;
  const unit = COMPACT_EXACT_UNITS.find(
    (candidate) =>
      majorExponent >= candidate.exponent &&
      majorExponent - candidate.exponent < 3,
  );
  if (unit) {
    return `${sign}${symbol}${formatScaledHundredths(abs, unit.exponent)}${unit.suffix}`;
  }

  const digits = major.toString();
  const mantissa = `${digits[0]}.${digits.slice(1, 3).padEnd(2, "0")}`;
  return `${sign}${symbol}${mantissa}e${digits.length - 1}`;
}

/** 축약 단위 없이 임의 크기 정수를 전체 자릿수로 표시한다. */
export function formatFullExactMoney(value: unknown, symbol = "$"): string {
  const amount = BigInt(normalizeExactAmount(value));
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const major = abs / 100n;
  const minor = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${symbol}${commaInteger(major)}.${minor}`;
}

export function formatSignedExactMoney(value: unknown, symbol = "$"): string {
  const normalized = normalizeExactAmount(value);
  return `${BigInt(normalized) >= 0n ? "+" : ""}${formatExactMoney(normalized, symbol)}`;
}

export function formatSignedFullExactMoney(value: unknown, symbol = "$"): string {
  const normalized = normalizeExactAmount(value);
  return `${BigInt(normalized) >= 0n ? "+" : ""}${formatFullExactMoney(normalized, symbol)}`;
}

export function formatExactPercent(
  value: unknown,
  fractionDigits = 2,
  signed = true,
): string {
  const scaled = decimalToScaledInteger(
    typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint"
      ? value
      : "0",
    fractionDigits,
  );
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const scale = pow10(fractionDigits);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(fractionDigits, "0");
  const prefix = negative ? "-" : signed ? "+" : "";
  if (whole.toString().length > 18) {
    const digits = whole.toString();
    return `${prefix}${digits[0]}.${digits.slice(1, 3).padEnd(2, "0")}e${
      digits.length - 1
    }%`;
  }
  return `${prefix}${commaInteger(whole)}${
    fractionDigits > 0 ? `.${fraction}` : ""
  }%`;
}
