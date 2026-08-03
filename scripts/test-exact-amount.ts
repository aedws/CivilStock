import assert from "node:assert";
import {
  decimalToScaledInteger,
  exactAdd,
  exactAmountFromNumber,
  exactPercentChange,
  exactPositionValue,
  exactQuantityMultiply,
  formatExactMoney,
  formatExactPercent,
  normalizeExactAmount,
  normalizeExactQuantity,
} from "../src/lib/number/exactAmount";

// 임의 정밀도 직렬화 — 2^53를 한참 넘는 값도 문자열로 손실 없이 왕복한다.
assert.equal(
  normalizeExactAmount("631890645106586400000000000000000000000000000000000000"),
  "631890645106586400000000000000000000000000000000000000",
);
assert.equal(
  exactAdd("631890645106586400000000000000000000000000000000000000", "25"),
  "631890645106586400000000000000000000000000000000000025",
);
assert.equal(decimalToScaledInteger("1.2345678", 6), 1_234_568n);
assert.equal(
  decimalToScaledInteger("6.318906451065864e+53", 0).toString(),
  "631890645106586400000000000000000000000000000000000000",
);
assert.equal(
  normalizeExactQuantity("1000000000000000000000.123456"),
  "1000000000000000000000.123456",
);
assert.equal(
  exactQuantityMultiply("1000000000000000000000.123456", 10),
  "10000000000000000000001.23456",
);
assert.equal(exactPositionValue(12345, "2.5"), "30863");
assert.equal(exactPercentChange("125", "100", 4), "25");
assert.equal(exactPercentChange("75", "100", 4), "-25");
assert.equal(formatExactMoney("123456789"), "$1.23M");
assert.equal(
  formatExactMoney("631890645106586400000000000000000000000000000000000000"),
  "$6.31e51",
);
assert.equal(
  formatExactPercent("726411673472286903911855472676773989612101804400", 2),
  "+7.26e47%",
);
assert.equal(exactAmountFromNumber(10_000_000), "10000000");

// 통화 기호 파라미터화(국가별 통화 대응).
assert.equal(formatExactMoney("123456789", "₩"), "₩1.23M");

console.log("exact amount serialization · arithmetic · formatting passed");
