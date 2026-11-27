import { defineSettings } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { type ReactNode, createContext, useContext, useMemo } from "react";
import { z } from "zod";

/**
 * 글자 크기. Paseo 앱에는 설정 → 외관 → 글꼴의 '인터페이스 크기'와 '콘텐츠 크기'가 있지만,
 * 플러그인 SDK 는 이 값을 주지 않는다 (theme 에는 색상만 있다). 그래서 같은 두 값을
 * 플러그인 설정으로 받는다. 화면 크기가 기기마다 달라서 device 단위로 저장한다.
 * 기본값 14/15 는 개발자가 쓰던 Paseo 값이다. Paseo 의 기본값인지는 확인하지 못했다.
 */
export const DEFAULT_INTERFACE_SIZE = 14;
export const DEFAULT_CONTENT_SIZE = 15;
export const FONT_SIZE_RANGE = { min: 10, max: 28 } as const;

const size = (fallback: number) => z.number().int().min(FONT_SIZE_RANGE.min).max(FONT_SIZE_RANGE.max).default(fallback);

export const displaySettings = defineSettings({
  id: "display",
  scope: "device",
  version: 1,
  schema: z.object({
    interfaceSize: size(DEFAULT_INTERFACE_SIZE),
    contentSize: size(DEFAULT_CONTENT_SIZE),
  }),
});

export interface Fonts {
  /** 화면 제목 */
  title: number;
  /** 결정할 것, 구역 제목 */
  heading: number;
  /** 요청 원문, 카드 본문, 계획, 미리보기, 입력창 */
  body: number;
  /** 버튼, 탭, 선택 박스 */
  label: number;
  /** 항목 라벨, 시간, 힌트, 모델 이름 */
  meta: number;
}

export function fontsFrom(interfaceSize: number, contentSize: number): Fonts {
  return {
    title: contentSize + 3,
    heading: contentSize + 1,
    body: contentSize,
    label: interfaceSize,
    meta: Math.max(FONT_SIZE_RANGE.min, interfaceSize - 2),
  };
}

const FontContext = createContext<Fonts>(fontsFrom(DEFAULT_INTERFACE_SIZE, DEFAULT_CONTENT_SIZE));

/** 화면 루트에서 한 번 읽어 아래로 내려 준다. 설정을 읽는 동안은 기본값으로 그린다. */
export function FontProvider({ children }: { children: ReactNode }) {
  const settings = useSettings(displaySettings);
  const interfaceSize = settings.status === "ready" ? settings.values.interfaceSize : DEFAULT_INTERFACE_SIZE;
  const contentSize = settings.status === "ready" ? settings.values.contentSize : DEFAULT_CONTENT_SIZE;
  const fonts = useMemo(() => fontsFrom(interfaceSize, contentSize), [interfaceSize, contentSize]);
  return <FontContext.Provider value={fonts}>{children}</FontContext.Provider>;
}

export function useFonts(): Fonts {
  return useContext(FontContext);
}
