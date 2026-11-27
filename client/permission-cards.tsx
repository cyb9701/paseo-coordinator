import type { AgentRef } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { sendInstructionRpc } from "../shared/model";
import { useCoordinatorState } from "./coordinator-state";
import { attentionCards } from "./attention";
import { summaryForError } from "./card-summaries";
import { toAgentRef, toWorkspaceRef } from "./refs";
import { usePending } from "./pending-store";
import {
  type PermissionAction,
  type PermissionRequest,
  type PermissionResponse,
  type QuestionItem,
  QUESTION_SKIPPED,
  actionResponse,
  decisionPrompt,
  instructionResponse,
  isQuestionAnswered,
  planText,
  questionItems,
  questionResponse,
  requestActions,
  toolFacts,
} from "./permissions";
import { WorkspaceProjectChip } from "./project-chip";
import { SummaryBlock } from "./summary-view";
import { breakSentences } from "./sentences";
import { formatAgo } from "./time";
import { Card, Chip, CodeBox, CtaButton, ErrorLine, Fold, InstructionBox, type ViewContext } from "./ui";

export interface CardAgent {
  agentId: string;
  hostId: string;
  title: string;
  workspaceId: string;
  since: string;
}

/** 카드 머리: 종류, 프로젝트, 워크스페이스 › 에이전트, 기다린 시간. 여러 워크스페이스의 카드가 섞여도 어디 일인지 바로 보이게 한다. */
export function CardHead({ kind, color, agent, ctx }: { kind: string; color: string; agent: CardAgent; ctx: ViewContext }) {
  const workspace = useWorkspace(toWorkspaceRef(agent.hostId, agent.workspaceId), (w) => w.title ?? w.name);
  // 윗줄은 종류·프로젝트·기다린 시간, 아랫줄은 워크스페이스 › 에이전트다. 한 줄에 모두 두면 좁은 화면에서 이름이 잘리고 시간이
  // 혼자 다음 줄로 떨어진다.
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Chip label={kind} color={color} theme={ctx.theme} />
        <View style={{ flexShrink: 1 }}>
          <WorkspaceProjectChip workspaceId={agent.workspaceId} ctx={ctx} />
        </View>
        <View style={{ flex: 1 }} />
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {ctx.t("time.waiting", { ago: formatAgo(agent.since, ctx.now, ctx.t) })}
        </Text>
      </View>
      <Text numberOfLines={2} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
        {`${workspace ?? ""} › ${agent.title}`}
      </Text>
    </View>
  );
}

export function OpenAgentButton({ agent, ctx, primary = false }: { agent: Pick<CardAgent, "agentId" | "hostId">; ctx: ViewContext; primary?: boolean }) {
  if (!ctx.navigation) return null;
  return (
    <CtaButton
      label={ctx.t("common.openAgent")}
      tone={primary ? "primary" : "neutral"}
      theme={ctx.theme}
      onPress={() => ctx.navigation?.openAgent({ agentId: agent.agentId, serverId: agent.hostId })}
    />
  );
}

function QuestionForm({
  items,
  selected,
  typed,
  onToggle,
  onType,
  ctx,
}: {
  items: QuestionItem[];
  selected: Record<string, string[]>;
  typed: Record<string, string>;
  onToggle(question: string, label: string, multi: boolean): void;
  onType(question: string, text: string): void;
  ctx: ViewContext;
}) {
  return (
    <View style={{ gap: 14 }}>
      {items.map((item) => (
        <View key={item.question} style={{ gap: 8 }}>
          {/* 에이전트의 질문은 길 때가 많다. 굵은 큰 글씨로 두면 벽처럼 보여서 본문 크기로 둔다. 짧은 머리말만 굵게 둔다. */}
          {item.header ? <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{item.header}</Text> : null}
          <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.5) }}>
            {breakSentences(item.question)}
            {item.multiSelect ? `  ${ctx.t("permission.multiSelect")}` : ""}
          </Text>
          <View style={{ gap: 6 }}>
            {item.options.map((option) => {
              const active = selected[item.question]?.includes(option.label) ?? false;
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={item.multiSelect ? "checkbox" : "radio"}
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={option.label}
                  onPress={() => onToggle(item.question, option.label, item.multiSelect)}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: active ? ctx.theme.colors.accent : ctx.theme.colors.border,
                    backgroundColor: active ? ctx.theme.colors.surface2 : ctx.theme.colors.surface0,
                    gap: 2,
                  }}
                >
                  <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: active ? "600" : "400" }}>
                    {active ? "● " : "○ "}
                    {option.label}
                  </Text>
                  {option.description ? <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{breakSentences(option.description)}</Text> : null}
                </Pressable>
              );
            })}
          </View>
          {item.allowOther ? (
            <TextInput
              value={typed[item.question] ?? ""}
              onChangeText={(text) => onType(item.question, text)}
              placeholder={ctx.t("permission.answerYourself")}
              placeholderTextColor={ctx.theme.colors.foregroundMuted}
              accessibilityLabel={ctx.t("permission.answerYourselfFor", { question: item.question })}
              style={{
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: ctx.theme.colors.border,
                backgroundColor: ctx.theme.colors.surface0,
                color: ctx.theme.colors.foreground,
                fontSize: ctx.fonts.body,
              }}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

// Paseo 가 준 동작(계획 승인의 Implement 등)은 그 label 을 쓰고, 기본 허용/거절은 화면 언어로 보인다.
function actionLabel(action: PermissionAction, ctx: ViewContext): string {
  if (action.label) return action.label;
  return action.behavior === "allow" ? ctx.t("permission.allow") : ctx.t("permission.deny");
}

/** 권한 요청과 에이전트의 질문(AskUserQuestion). 플러그인이 대신 답하지 않고 사람이 카드에서 바로 답한다. */
function PermissionCard({ request, agent, ctx }: { request: PermissionRequest; agent: CardAgent; ctx: ViewContext }) {
  return (
    <Card color={ctx.theme.colors.statusDanger} ctx={ctx}>
      <CardHead kind={ctx.t(`kinds.${request.kind}`)} color={ctx.theme.colors.statusDanger} agent={agent} ctx={ctx} />
      <PermissionBody request={request} agent={agent} ctx={ctx} />
    </Card>
  );
}

/** 권한 요청의 본문과 버튼. 멈춘 결정 카드는 에이전트가 질문 창으로 물었을 때 이것을 답 칸 자리에 넣는다. */
export function PermissionBody({ request, agent, ctx }: { request: PermissionRequest; agent: CardAgent; ctx: ViewContext }) {
  const paseo = usePaseo();
  const respond = useMutation({
    mutationFn: (response: PermissionResponse) => paseo.agents.ref(toAgentRef(agent.hostId, agent.agentId)).respondToPermission({ requestId: request.id, response }),
  });
  const [instructing, setInstructing] = useState(false);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const busy = respond.isPending;
  const questions = request.kind === "question" ? questionItems(request) : [];
  const plan = request.kind === "plan" ? planText(request) : null;
  const facts = request.kind === "tool" ? toolFacts(request) : null;
  const actions = requestActions(request);
  const allAnswered = questions.length > 0 && questions.every((item) => isQuestionAnswered(item, selected, typed));
  const toggle = (question: string, label: string, multi: boolean) =>
    setSelected((current) => {
      const previous = current[question] ?? [];
      const next = multi ? (previous.includes(label) ? previous.filter((value) => value !== label) : [...previous, label]) : [label];
      return { ...current, [question]: next };
    });
  return (
    <View style={{ gap: 12 }}>
      {/* 허용할 명령 원문은 밖에 둔다. 명령을 보지 않고 허용하면 안 된다. 입력값, 설명, 계획 원문은 자세히 보기에 있다. */}
      {questions.length > 0 ? (
        <QuestionForm
          items={questions}
          selected={selected}
          typed={typed}
          onToggle={toggle}
          onType={(question, text) => setTyped((current) => ({ ...current, [question]: text }))}
          ctx={ctx}
        />
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{decisionPrompt(request, ctx.t)}</Text>
          {facts?.command ? <CodeBox text={facts.command} ctx={ctx} /> : null}
        </View>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {request.kind === "question" ? (
          <>
            <CtaButton
              label={ctx.t("permission.sendAnswer")}
              tone="primary"
              disabled={busy || !allAnswered}
              theme={ctx.theme}
              onPress={() => respond.mutate(questionResponse(questions, selected, typed))}
            />
            <CtaButton
              label={ctx.t("permission.skipQuestion")}
              disabled={busy}
              theme={ctx.theme}
              onPress={() => respond.mutate({ behavior: "deny", message: QUESTION_SKIPPED })}
            />
          </>
        ) : (
          actions.map((action) => (
            <CtaButton
              key={action.id}
              label={actionLabel(action, ctx)}
              tone={action.behavior === "allow" && action.variant !== "secondary" ? "primary" : "neutral"}
              disabled={busy}
              theme={ctx.theme}
              onPress={() => respond.mutate(actionResponse(request, action))}
            />
          ))
        )}
        <CtaButton
          label={instructing ? ctx.t("common.closeInstruct") : ctx.t("common.instruct")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setInstructing((value) => !value)}
        />
        <OpenAgentButton agent={agent} ctx={ctx} />
      </View>
      {instructing ? (
        <InstructionBox
          placeholder={ctx.t("permission.instructionPlaceholder")}
          submitLabel={ctx.t("permission.denyWithInstruction")}
          busy={busy}
          ctx={ctx}
          onSubmit={(text) => respond.mutateAsync(instructionResponse(request, text))}
        />
      ) : null}
      <ErrorLine error={respond.error} ctx={ctx} />
      <Fold
        ctx={ctx}
        items={[
          facts && facts.inputs.length > 0
            ? {
                label: ctx.t("permission.facts"),
                count: facts.inputs.length,
                content: facts.inputs.map(([key, value]) => (
                  <Text key={key} selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
                    {`${key}: ${value}`}
                  </Text>
                )),
              }
            : null,
          request.description && request.kind !== "question"
            ? { label: ctx.t("permission.description"), content: <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>{breakSentences(request.description)}</Text> }
            : null,
          plan ? { label: ctx.t("permission.plan"), content: <CodeBox text={plan} ctx={ctx} maxHeight={320} /> } : null,
        ]}
      />
    </View>
  );
}

/** 실패한 턴. 앞뒤 상황 요약이 있으면 함께 보이고, 다음 지시를 보낼 수 있다. */
function ErrorCard({ message, agent, ctx }: { message: string | null; agent: CardAgent; ctx: ViewContext }) {
  const { state } = useCoordinatorState();
  const instruct = useRpc(sendInstructionRpc);
  const send = useMutation({ mutationFn: (text: string) => instruct({ agentId: agent.agentId, text }) });
  const [instructing, setInstructing] = useState(false);
  const current = summaryForError(state, agent.agentId, agent.since);
  return (
    <Card color={ctx.theme.colors.statusDanger} ctx={ctx}>
      <CardHead kind={ctx.t("kinds.error")} color={ctx.theme.colors.statusDanger} agent={agent} ctx={ctx} />
      <CodeBox text={message ?? ctx.t("permission.errorNoMessage")} ctx={ctx} maxHeight={200} />
      <SummaryBlock summary={current} agentId={agent.agentId} ctx={ctx} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={instructing ? ctx.t("common.closeInstruct") : ctx.t("common.instruct")}
          tone="primary"
          disabled={send.isPending}
          theme={ctx.theme}
          onPress={() => setInstructing((value) => !value)}
        />
        <OpenAgentButton agent={agent} ctx={ctx} />
      </View>
      {instructing ? (
        <InstructionBox
          placeholder={ctx.t("permission.nextInstructionPlaceholder")}
          submitLabel={send.isPending ? ctx.t("common.sending") : ctx.t("common.send")}
          busy={send.isPending}
          ctx={ctx}
          onSubmit={(text) => send.mutateAsync(text).then(() => setInstructing(false))}
        />
      ) : null}
      {send.data?.delivery === "queued" ? <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("common.queued")}</Text> : null}
      <ErrorLine error={send.error} ctx={ctx} />
    </Card>
  );
}

/** 한 에이전트가 기다리는 권한 요청과 에러를 카드로 그린다. 권한 요청이 여러 개면 카드도 여러 개다. */
export function AgentAttention({ agentRef, ctx, folded = false }: { agentRef: AgentRef; ctx: ViewContext; folded?: boolean }) {
  const directory = usePending();
  const agent = useAgent(agentRef, (a) => ({
    title: a.title,
    workspaceId: a.workspaceId,
    hostId: a.hostId,
    lastActivityAt: a.lastActivityAt,
    status: a.status,
    attentionReason: a.attentionReason,
  }));
  if (!agent) return null;
  const cardAgent: CardAgent = {
    agentId: agentRef.id,
    hostId: agent.hostId,
    title: agent.title ?? ctx.t("common.untitledAgent"),
    workspaceId: agent.workspaceId,
    since: agent.lastActivityAt,
  };
  // 멈춘 결정이 있는 에이전트의 질문은 그 결정 카드 안에 그린다(folded). 카드가 두 장 뜨지 않게 여기서는 뺀다.
  const { requests: pending, hidden } = attentionCards(directory, agentRef.id, folded);
  if (hidden) return null;
  if (pending.length > 0) {
    return (
      <>
        {pending.map((request) => (
          <PermissionCard key={request.id} request={request} agent={cardAgent} ctx={ctx} />
        ))}
      </>
    );
  }
  if (agent.status === "error" || agent.attentionReason === "error") {
    return <ErrorCard message={directory.errors.get(agentRef.id) ?? null} agent={cardAgent} ctx={ctx} />;
  }
  // attentionReason 은 권한 대기인데 목록 구독이 아직 요청을 받지 못한 짧은 순간.
  return (
    <Card color={ctx.theme.colors.statusDanger} ctx={ctx}>
      <CardHead kind={ctx.t("kinds.other")} color={ctx.theme.colors.statusDanger} agent={cardAgent} ctx={ctx} />
      <Text style={{ color: ctx.theme.colors.foreground }}>
        {directory.failure
          ? ctx.t("permission.requestListFailed", { reason: directory.failure })
          : directory.ready
            ? ctx.t("permission.requestNotFound")
            : ctx.t("permission.loadingRequest")}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <OpenAgentButton agent={cardAgent} ctx={ctx} />
      </View>
    </Card>
  );
}
