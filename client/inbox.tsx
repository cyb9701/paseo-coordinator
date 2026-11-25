import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { AgentRef } from "@getpaseo/plugin/client";
import { useAgent, useAgents, usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { AgentCard } from "./agent-card";
import { columnColor, isVisibleAgent } from "./agent-state";
import { AnswerCard } from "./answer-card";
import { requestNeedsReaction, requestNeedsReview, useCoordinatorState, useSentLog } from "./coordinator-state";
import { StartedCard } from "./plan-card";
import { QuestionCard } from "./question-card";
import { cardCount, useClassifier, usePending } from "./pending-store";
import {
  type PermissionAction,
  type PermissionRequest,
  type PermissionResponse,
  type QuestionItem,
  actionResponse,
  decisionPrompt,
  instructionResponse,
  isQuestionAnswered,
  planText,
  questionItems,
  QUESTION_SKIPPED,
  questionResponse,
  requestActions,
  toolFacts,
} from "./permissions";
import { formatAgo } from "./time";
import { Chip, CtaButton, type ViewContext } from "./ui";

// 반응 필요는 오래 기다린 순서, 확인 필요는 최근 순서 (RULES.md §12).
function oldestFirst(a: PluginAgentSnapshot, b: PluginAgentSnapshot): number {
  return Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt);
}

// 처리 결과는 에이전트 목록 구독(pending-store)으로 돌아오므로 여기서 따로 다시 읽지 않는다.
// 보낸 지시는 mutationFn 안에서 바로 기록한다. 보내자마자 에이전트가 running 이 되어 카드가 사라지면,
// mutate 에 넘긴 onSuccess 는 실행되지 않아 기록이 빠졌다 (2026-11-25 테스트).
function useAgentActions(agentId: string) {
  const paseo = usePaseo();
  const { record } = useSentLog();
  const respond = useMutation({
    mutationFn: ({ requestId, response }: { requestId: string; response: PermissionResponse }) =>
      paseo.agents.ref(agentId).respondToPermission({ requestId, response }),
  });
  const send = useMutation({
    mutationFn: async (text: string) => {
      await paseo.agents.ref(agentId).send(text);
      // 지시는 이미 갔으므로 기록 실패로 전송을 실패 처리하지 않는다.
      record(agentId, text.trim()).catch((error) => console.error("[coordinator] could not record instruction", error));
    },
  });
  return { respond, send };
}

function InstructionBox({
  placeholder,
  submitLabel,
  onSubmit,
  busy,
  ctx,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit(text: string): void;
  busy: boolean;
  ctx: ViewContext;
}) {
  const [text, setText] = useState("");
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={ctx.theme.colors.foregroundMuted}
        multiline
        accessibilityLabel={placeholder}
        style={{
          minHeight: 72,
          padding: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: ctx.theme.colors.border,
          backgroundColor: ctx.theme.colors.surface0,
          color: ctx.theme.colors.foreground,
          fontSize: ctx.fonts.body,
          textAlignVertical: "top",
        }}
      />
      <View style={{ flexDirection: "row" }}>
        <CtaButton
          label={submitLabel}
          tone="primary"
          disabled={busy || text.trim().length === 0}
          theme={ctx.theme}
          onPress={() => onSubmit(text)}
        />
      </View>
    </View>
  );
}

function Section({ label, value, ctx }: { label: string; value: ReactNode; ctx: ViewContext }) {
  return (
    <View style={{ flexDirection: ctx.compact ? "column" : "row", gap: ctx.compact ? 4 : 12 }}>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, width: ctx.compact ? undefined : 72 }}>
        {label}
      </Text>
      <View style={{ flex: 1, gap: 4 }}>{value}</View>
    </View>
  );
}

function CodeBox({ text, ctx, maxHeight }: { text: string; ctx: ViewContext; maxHeight?: number }) {
  const body = (
    <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontFamily: "monospace", lineHeight: Math.round(ctx.fonts.meta * 1.5) }}>
      {text}
    </Text>
  );
  return (
    <View
      style={{
        padding: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        backgroundColor: ctx.theme.colors.surface0,
      }}
    >
      {maxHeight ? <ScrollView style={{ maxHeight }}>{body}</ScrollView> : body}
    </View>
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
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>
            {item.question}
            {item.multiSelect ? `  ${ctx.t("inbox.multiSelect")}` : ""}
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
                  {option.description ? (
                    <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{option.description}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          {item.allowOther ? (
            <TextInput
              value={typed[item.question] ?? ""}
              onChangeText={(text) => onType(item.question, text)}
              placeholder={ctx.t("inbox.answerYourself")}
              placeholderTextColor={ctx.theme.colors.foregroundMuted}
              accessibilityLabel={ctx.t("inbox.answerYourselfFor", { question: item.question })}
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

interface CardAgent {
  agentId: string;
  hostId: string;
  title: string;
  workspaceId: string;
  since: string;
}

function CardFrame({
  kind,
  agent,
  ctx,
  children,
}: {
  kind: string;
  agent: CardAgent;
  ctx: ViewContext;
  children: ReactNode;
}) {
  const workspace = useWorkspace(agent.workspaceId, (w) => `${w.projectDisplayName} · ${w.title ?? w.name}`);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: columnColor("react", ctx.theme),
        borderRadius: 10,
        backgroundColor: ctx.theme.colors.surface1,
        padding: ctx.compact ? 12 : 16,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Chip label={kind} color={columnColor("react", ctx.theme)} theme={ctx.theme} />
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, flexShrink: 1 }}>
          {`${workspace ?? ""} › ${agent.title}`}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("time.waiting", { ago: formatAgo(agent.since, ctx.now, ctx.t) })}</Text>
      </View>
      {children}
    </View>
  );
}

function ErrorLine({ error, ctx }: { error: unknown; ctx: ViewContext }) {
  if (!error) return null;
  return (
    <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
      {ctx.t("inbox.failed", { message: error instanceof Error ? error.message : String(error) })}
    </Text>
  );
}

function OpenAgentButton({ agent, ctx, primary = false }: { agent: CardAgent; ctx: ViewContext; primary?: boolean }) {
  if (!ctx.navigation) return null;
  return (
    <CtaButton
      label={ctx.t("inbox.openAgent")}
      tone={primary ? "primary" : "neutral"}
      theme={ctx.theme}
      onPress={() => ctx.navigation?.openAgent({ agentId: agent.agentId, serverId: agent.hostId })}
    />
  );
}

// Paseo 가 준 동작(계획 승인의 Implement 등)은 그 label 을 쓰고, 기본 허용/거절은 화면 언어로 보인다.
function actionLabel(action: PermissionAction, ctx: ViewContext): string {
  if (action.label) return action.label;
  return action.behavior === "allow" ? ctx.t("inbox.allow") : ctx.t("inbox.deny");
}

function DecisionCard({ request, agent, ctx }: { request: PermissionRequest; agent: CardAgent; ctx: ViewContext }) {
  const { respond } = useAgentActions(agent.agentId);
  const [instructing, setInstructing] = useState(false);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const busy = respond.isPending;
  const submit = (response: PermissionResponse) => respond.mutate({ requestId: request.id, response });

  const questions = request.kind === "question" ? questionItems(request) : [];
  const plan = request.kind === "plan" ? planText(request) : null;
  const facts = request.kind === "tool" ? toolFacts(request) : null;
  const actions = requestActions(request);
  const allAnswered = questions.length > 0 && questions.every((item) => isQuestionAnswered(item, selected, typed));

  const toggle = (question: string, label: string, multi: boolean) =>
    setSelected((current) => {
      const previous = current[question] ?? [];
      const next = multi
        ? previous.includes(label)
          ? previous.filter((value) => value !== label)
          : [...previous, label]
        : [label];
      return { ...current, [question]: next };
    });

  return (
    <CardFrame kind={ctx.t(`kinds.${request.kind}`)} agent={agent} ctx={ctx}>
      {facts ? (
        <Section
          label={ctx.t("inbox.facts")}
          ctx={ctx}
          value={
            <>
              {facts.command ? <CodeBox text={facts.command} ctx={ctx} /> : null}
              {facts.inputs.map(([key, value]) => (
                <Text key={key} selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
                  {`${key}: ${value}`}
                </Text>
              ))}
              {request.description ? (
                <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{request.description}</Text>
              ) : null}
            </>
          }
        />
      ) : null}
      {plan ? <Section label={ctx.t("inbox.plan")} ctx={ctx} value={<CodeBox text={plan} ctx={ctx} maxHeight={320} />} /> : null}
      {/* 사실과 계획을 먼저 읽고, 결정할 것은 버튼(질문이면 선택지) 바로 위에 둔다. */}
      <Section
        label={ctx.t("inbox.decide")}
        ctx={ctx}
        value={
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
            {decisionPrompt(request, ctx.t)}
          </Text>
        }
      />
      {questions.length > 0 ? (
        <QuestionForm
          items={questions}
          selected={selected}
          typed={typed}
          onToggle={toggle}
          onType={(question, text) => setTyped((current) => ({ ...current, [question]: text }))}
          ctx={ctx}
        />
      ) : null}
      {request.kind !== "tool" && request.kind !== "plan" && request.kind !== "question" && request.description ? (
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{request.description}</Text>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {request.kind === "question" ? (
          <>
            <CtaButton
              label={ctx.t("inbox.sendAnswer")}
              tone="primary"
              disabled={busy || !allAnswered}
              theme={ctx.theme}
              onPress={() => submit(questionResponse(questions, selected, typed))}
            />
            <CtaButton
              label={ctx.t("inbox.skipQuestion")}
              disabled={busy}
              theme={ctx.theme}
              onPress={() => submit({ behavior: "deny", message: QUESTION_SKIPPED })}
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
              onPress={() => submit(actionResponse(request, action))}
            />
          ))
        )}
        <CtaButton
          label={instructing ? ctx.t("inbox.closeInstruct") : ctx.t("inbox.instruct")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setInstructing((value) => !value)}
        />
        <OpenAgentButton agent={agent} ctx={ctx} />
      </View>
      {instructing ? (
        <InstructionBox
          placeholder={ctx.t("inbox.instructionPlaceholder")}
          submitLabel={ctx.t("inbox.denyWithInstruction")}
          busy={busy}
          ctx={ctx}
          onSubmit={(text) => submit(instructionResponse(request, text))}
        />
      ) : null}
      <ErrorLine error={respond.error} ctx={ctx} />
    </CardFrame>
  );
}

function ErrorCard({ message, agent, ctx }: { message: string | null; agent: CardAgent; ctx: ViewContext }) {
  const { send } = useAgentActions(agent.agentId);
  const { sent } = useSentLog();
  const [instructing, setInstructing] = useState(false);
  const history = sent.get(agent.agentId) ?? [];
  const last = history[history.length - 1];
  // 지시를 보낸 뒤 에이전트가 다시 움직였다가 또 에러로 멈춘 경우. 같은 지시를 반복해도 풀리지 않을 가능성이 크다.
  const failedAgain = last !== undefined && Date.parse(agent.since) > Date.parse(last.at);
  return (
    <CardFrame kind={ctx.t("inbox.error")} agent={agent} ctx={ctx}>
      <Section label={ctx.t("inbox.error")} ctx={ctx} value={<CodeBox text={message ?? ctx.t("inbox.errorNoMessage")} ctx={ctx} maxHeight={200} />} />
      {history.length > 0 ? (
        <Section
          label={ctx.t("inbox.sentInstructions")}
          ctx={ctx}
          value={history.slice(-3).map((item) => (
            <Text key={item.at} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
              {`${formatAgo(item.at, ctx.now, ctx.t)} · ${item.text}`}
            </Text>
          ))}
        />
      ) : null}
      <Section
        label={ctx.t("inbox.decide")}
        ctx={ctx}
        value={
          <>
            <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
              {failedAgain
                ? ctx.t("inbox.errorAgain")
                : ctx.t("inbox.errorDecide")}
            </Text>
            {failedAgain ? (
              <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
                {ctx.t("inbox.errorAgainHint")}
              </Text>
            ) : null}
          </>
        }
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={instructing ? ctx.t("inbox.closeInstruct") : ctx.t("inbox.instruct")}
          tone={failedAgain ? "neutral" : "primary"}
          disabled={send.isPending}
          theme={ctx.theme}
          onPress={() => setInstructing((value) => !value)}
        />
        <OpenAgentButton agent={agent} ctx={ctx} primary={failedAgain} />
      </View>
      {instructing ? (
        <InstructionBox
          placeholder={ctx.t("inbox.nextInstructionPlaceholder")}
          submitLabel={send.isPending ? ctx.t("inbox.sending") : ctx.t("inbox.send")}
          busy={send.isPending}
          ctx={ctx}
          onSubmit={(text) => send.mutate(text, { onSuccess: () => setInstructing(false) })}
        />
      ) : null}
      <ErrorLine error={send.error} ctx={ctx} />
    </CardFrame>
  );
}

/** 한 에이전트가 기다리는 것을 모두 카드로 그린다. 권한 요청이 여러 개면 카드도 여러 개다. */
function AgentDecisions({ agentRef, ctx }: { agentRef: AgentRef; ctx: ViewContext }) {
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
    title: agent.title ?? ctx.t("card.untitledAgent"),
    workspaceId: agent.workspaceId,
    since: agent.lastActivityAt,
  };
  const pending = directory.pending.get(agentRef.id) ?? [];
  if (pending.length > 0) {
    return (
      <>
        {pending.map((request) => (
          <DecisionCard key={request.id} request={request} agent={cardAgent} ctx={ctx} />
        ))}
      </>
    );
  }
  if (agent.status === "error" || agent.attentionReason === "error") {
    return <ErrorCard message={directory.errors.get(agentRef.id) ?? null} agent={cardAgent} ctx={ctx} />;
  }
  // attentionReason 은 권한 대기인데 목록 구독이 아직 요청을 받지 못한 짧은 순간.
  return (
    <CardFrame kind={ctx.t("kinds.other")} agent={cardAgent} ctx={ctx}>
      <Text style={{ color: ctx.theme.colors.foreground }}>
        {directory.ready ? ctx.t("inbox.requestNotFound") : ctx.t("inbox.loadingRequest")}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <OpenAgentButton agent={cardAgent} ctx={ctx} />
      </View>
    </CardFrame>
  );
}

function SectionHeader({ title, count, hint, color, ctx }: { title: string; count: number; hint: string; color: string; ctx: ViewContext }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text style={{ color, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading }}>{String(count)}</Text>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{hint}</Text>
    </View>
  );
}

/** 결정 인박스. 반응 필요는 카드에서 바로 처리하고, 확인 필요는 열어서 본다 (RULES.md §12). */
export function InboxView({ ctx }: { ctx: ViewContext }) {
  const classify = useClassifier();
  const directory = usePending();
  const needsReaction = (agent: PluginAgentSnapshot) => isVisibleAgent(agent) && classify.column(agent) === "react";
  const needsReview = (agent: PluginAgentSnapshot) => isVisibleAgent(agent) && classify.column(agent) === "review";
  const reacting = useAgents({ hosts: [ctx.hostId], where: needsReaction, orderBy: oldestFirst });
  const reviewing = useAgents({ hosts: [ctx.hostId], where: needsReview, orderBy: ["lastActivityAt", "desc"] });
  // 질문 카드는 요청 전체를 막고 있어서 에이전트 카드보다 위에, 오래 기다린 순서로 둔다.
  const { state } = useCoordinatorState();
  const requests = state?.requests ?? [];
  const questions = requests
    .filter(requestNeedsReaction)
    .sort((a, b) => (a.question?.at ?? a.createdAt).localeCompare(b.question?.at ?? b.createdAt));
  // 확인 필요는 최근 순서. 답변 카드와 시작 카드가 에이전트 카드보다 위다.
  const reviews = requests
    .filter(requestNeedsReview)
    .sort((a, b) => (b.answer?.at ?? b.plannedAt ?? b.createdAt).localeCompare(a.answer?.at ?? a.plannedAt ?? a.createdAt));
  const reactCount = questions.length + cardCount(reacting.map((ref) => ref.id), directory);
  const reviewCount = reviews.length + reviewing.length;
  return (
    <View style={{ gap: 20, maxWidth: 880 }}>
      <View style={{ gap: 10 }}>
        <SectionHeader
          title={ctx.t("inbox.react")}
          count={reactCount}
          hint={ctx.t("inbox.reactHint")}
          color={columnColor("react", ctx.theme)}
          ctx={ctx}
        />
        {reactCount === 0 ? (
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.body }}>{ctx.t("inbox.nothingBlocked")}</Text>
        ) : null}
        {questions.map((request) => (
          <QuestionCard key={request.id} request={request} ctx={ctx} />
        ))}
        {reacting.map((ref) => (
          <AgentDecisions key={ref.key} agentRef={ref} ctx={ctx} />
        ))}
      </View>
      <View style={{ gap: 10 }}>
        <SectionHeader
          title={ctx.t("inbox.review")}
          count={reviewCount}
          hint={ctx.t("inbox.reviewHint")}
          color={columnColor("review", ctx.theme)}
          ctx={ctx}
        />
        {reviewCount === 0 ? (
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.body }}>{ctx.t("inbox.nothingToReview")}</Text>
        ) : null}
        {reviews.map((request) =>
          request.status === "answered" ? (
            <AnswerCard key={request.id} request={request} ctx={ctx} />
          ) : (
            <StartedCard key={request.id} request={request} ctx={ctx} />
          ),
        )}
        {reviewing.map((ref) => (
          <AgentCard key={ref.key} agentRef={ref} ctx={ctx} />
        ))}
      </View>
    </View>
  );
}
