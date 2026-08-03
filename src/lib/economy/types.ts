/**
 * 경제 모듈 도메인 타입.
 *
 * 핵심 전환(vs 2DStock): 발행권을 유저에게 이양한다. 유저가 주식·ETF·채권을
 * 발행하고, 가격은 결정론이 아니라 **유저 주문 흐름에서 창발**한다(서버 권위형
 * 매칭). 운영자는 제재·삭제만.
 *
 * 금액/수량 규율(2DStock에서 검증):
 * - 통화 금액은 **정수 최소단위(minor unit) 문자열** = ExactAmount. float 금지.
 * - 가격은 "증권 1.0단위당 결제통화 최소단위" 정수 문자열.
 * - 수량은 최대 6자리 소수 문자열(micros). exactAmount 유틸로만 연산.
 */
import type { ExactAmount } from "../number/exactAmount";

/** 증권(상품) 종류. 발행 주체·정산 방식이 다르다. */
export type SecurityType =
  | "equity" // 유저 회사 주식
  | "bond" // 국채/회사채
  | "etf" // 유저가 구성한 바스켓
  | "adr" // 타 시장 상장 증권의 예탁증서(교차 상장)
  | "currency" // 국가 통화(FX)
  | "commodity" // 실물 자원/재화
  | "option" // 파생: 옵션
  | "future"; // 파생: 선물/무기한

export type Side = "buy" | "sell";

/** 모든 상품의 공통 헤더. 종류별 상세는 별도 detail 레코드로 확장한다. */
export interface Security {
  id: string;
  type: SecurityType;
  ticker: string;
  /** 발행 유저. 국가/시스템 발행(통화·자원)은 null. */
  issuerUserId: string | null;
  nationId: string;
  exchangeId: string;
  /** 결제 통화 코드(국가 통화). 정수 최소단위 기준. */
  currency: string;
  /** 운영자 제재 상태. delisted/frozen이면 매칭 불가. */
  status: "listed" | "frozen" | "delisted";
}

/** 주식 상세: 발행량은 유저가 통제(증자·자사주·분할·배당). */
export interface EquityDetails {
  securityId: string;
  /** 발행주식수(6dp micros 문자열). 증자/자사주로 변동. */
  sharesOutstanding: string;
}

/** 채권 상세: 원금·표면금리·만기. 쿠폰은 틱마다 발생. */
export interface BondDetails {
  securityId: string;
  /** 액면 원금(정수 최소단위 문자열, 1좌당). */
  faceValue: ExactAmount;
  /** 표면금리(연) — 백분율 10진 문자열, 예 "5.25". */
  couponRate: string;
  /** 만기 틱(worldTick 번호). */
  maturityTick: number;
  /** 쿠폰 지급 주기(틱). */
  couponIntervalTicks: number;
}

/** ETF 상세: 구성종목·비중. 생성/상환은 바스켓 대비로. */
export interface EtfDetails {
  securityId: string;
  constituents: Array<{
    /** 편입 상품(주식·채권·다른 ETF·자원 가능). */
    securityId: string;
    /** ETF 1주당 편입 수량(6dp micros 문자열). */
    unitsPerShare: string;
  }>;
}

/**
 * ADR 상세(예외적 교차 상장): 홈 시장 증권을 다른 시장의 통화로 거래.
 * ADR 1주 = 홈 주식 `ratio`주. 가격은 홈 가격 × FX × (1/ratio)에 수렴하되,
 * 실제 시세는 자시장 주문 흐름에서 창발(차익거래 여지).
 */
export interface AdrDetails {
  securityId: string;
  /** 원본(홈) 증권 id. */
  underlyingSecurityId: string;
  /** ADR 1주가 나타내는 홈 주식 수(6dp micros 문자열). */
  ratio: string;
  /** 예탁기관(유저/기관). 홈 주식을 보관하고 ADR을 발행·상환. */
  depositaryUserId: string;
}

/** 옵션 상세: 기초자산·행사가·만기·계약규모. */
export interface OptionDetails {
  securityId: string;
  underlyingSecurityId: string;
  kind: "call" | "put";
  /** 행사가(기초 1.0단위당 결제통화 최소단위, 정수 문자열). */
  strike: ExactAmount;
  /** 만기 틱(worldTick 번호). */
  expiryTick: number;
  /** 1계약당 기초자산 수량(6dp micros 문자열). */
  contractSize: string;
  settlement: "physical" | "cash";
}

/** 선물/무기한 상세: 기초자산·만기·증거금률. */
export interface FutureDetails {
  securityId: string;
  underlyingSecurityId: string;
  /** 만기 틱. 무기한(perp)이면 null. */
  expiryTick: number | null;
  /** 1계약당 기초자산 수량(6dp micros 문자열). */
  contractSize: string;
  /** 개시증거금률(bps). 예: 1000 = 10%. */
  initialMarginBps: number;
  /** 유지증거금률(bps). 이하로 내려가면 청산. */
  maintenanceMarginBps: number;
}

/**
 * 공매도/파생을 위한 증거금 요구. 정산 엔진(다음 슬라이스)이 계정 순자산 대비
 * 유지증거금을 초과하는 손실을 강제청산한다. 현재는 스키마·불변식만 정의.
 */
export interface MarginRequirement {
  /** 이 포지션이 요구하는 증거금(정수 최소단위 문자열). */
  required: ExactAmount;
  /** 예치된 담보(정수 최소단위 문자열). */
  posted: ExactAmount;
}

/** 지정가 주문. 시장가는 limitPrice를 극단값으로 두는 상위 계층에서 처리. */
export interface Order {
  id: string;
  securityId: string;
  side: Side;
  ownerId: string;
  /** 증권 1.0단위당 결제통화 최소단위(정수 문자열). */
  limitPrice: ExactAmount;
  /** 미체결 잔량(6dp micros 문자열). */
  quantity: string;
  /** 시간우선순위용 타임스탬프(작을수록 먼저). */
  ts: number;
}

/** 체결 한 건. 가격은 메이커(호가 게시자) 가격을 따른다. */
export interface Fill {
  makerOrderId: string;
  makerId: string;
  takerId: string;
  takerSide: Side;
  /** 체결가(정수 최소단위 문자열). */
  price: ExactAmount;
  /** 체결 수량(6dp micros 문자열). */
  quantity: string;
  /** 결제 금액 = price × quantity(정수 최소단위 문자열). */
  value: ExactAmount;
}
