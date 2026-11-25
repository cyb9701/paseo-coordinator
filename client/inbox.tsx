import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { AgentRef } from "@getpaseo/plugin/client";
import { useAgent, useAgents, usePaseo, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { AgentCard } from "./agent-card";
import { columnColor, isVisibleAgent } from "./agent-state";
import { useClassifier, usePending, useSentLog } from "./pending-store";
import {
  KIND_LABELS,
  type PermissionRequest,
  type PermissionResponse,
  type QuestionItem,
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
      record(agentId, text.trim());
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
          fontSize: 13,
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
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12, width: ctx.compact ? undefined : 72 }}>
        {label}
      </Text>
      <View style={{ flex: 1, gap: 4 }}>{value}</View>
    </View>
  );
}

function CodeBox({ text, ctx, maxHeight }: { text: string; ctx: ViewContext; maxHeight?: number }) {
  const body = (
    <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: 12, fontFamily: "monospace", lineHeight: 18 }}>
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
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            {item.question}
            {item.multiSelect ? "  (여러 개 선택)" : ""}
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
                  <Text style={{ color: ctx.theme.colors.foreground, fontSize: 13, fontWeight: active ? "600" : "400" }}>
                    {active ? "● " : "○ "}
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>{option.description}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          {item.allowOther ? (
            <TextInput
              value={typed[item.question] ?? ""}
              onChangeText={(text) => onType(item.question, text)}
              placeholder="직접 답하기"
              placeholderTextColor={ctx.theme.colors.foregroundMuted}
              accessibilityLabel={`${item.question} 직접 답하기`}
              style={{
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: ctx.theme.colors.border,
                backgroundColor: ctx.theme.colors.surface0,
                color: ctx.theme.colors.foreground,
                fontSize: 13,
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
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
          {`${workspace ?? ""} › ${agent.title}`}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>{`${formatAgo(agent.since, ctx.now)} 대기`}</Text>
      </View>
      {children}
    </View>
  );
}

function ErrorLine({ error, ctx }: { error: unknown; ctx: ViewContext }) {
  if (!error) return null;
  return (
    <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: 12 }}>
      {`처리하지 못했어요: ${error instanceof Error ? error.message : String(error)}`}
    </Text>
  );
}

function OpenAgentButton({ agent, ctx, primary = false }: { agent: CardAgent; ctx: ViewContext; primary?: boolean }) {
  if (!ctx.navigation) return null;
  return (
    <CtaButton
      label="에이전트 열기 ↗"
      tone={primary ? "primary" : "neutral"}
      theme={ctx.theme}
      onPress={() => ctx.navigation?.openAgent({ agentId: agent.agentId, serverId: agent.hostId })}
    />
  );
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
    <CardFrame kind={KIND_LABELS[request.kind]} agent={agent} ctx={ctx}>
      <Section
        label="결정할 것"
        ctx={ctx}
        value={
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
            {decisionPrompt(request)}
          </Text>
        }
      />
      {facts ? (
        <Section
          label="사실"
          ctx={ctx}
          value={
            <>
              {facts.command ? <CodeBox text={facts.command} ctx={ctx} /> : null}
              {facts.inputs.map(([key, value]) => (
                <Text key={key} selectable style={{ color: ctx.theme.colors.foreground, fontSize: 12 }}>
                  {`${key}: ${value}`}
                </Text>
              ))}
              {request.description ? (
                <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>{request.description}</Text>
              ) : null}
            </>
          }
        />
      ) : null}
      {plan ? <Section label="계획" ctx={ctx} value={<CodeBox text={plan} ctx={ctx} maxHeight={320} />} /> : null}
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
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>{request.description}</Text>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {request.kind === "question" ? (
          <>
            <CtaButton
              label="답변 보내기"
              tone="primary"
              disabled={busy || !allAnswered}
              theme={ctx.theme}
              onPress={() => submit(questionResponse(questions, selected, typed))}
            />
            <CtaButton
              label="질문 거절"
              disabled={busy}
              theme={ctx.theme}
              onPress={() => submit({ behavior: "deny", message: "사용자가 질문에 답하지 않고 넘겼습니다." })}
            />
          </>
        ) : (
          actions.map((action) => (
            <CtaButton
              key={action.id}
              label={action.label}
              tone={action.behavior === "allow" && action.variant !== "secondary" ? "primary" : "neutral"}
              disabled={busy}
              theme={ctx.theme}
              onPress={() => submit(actionResponse(request, action))}
            />
          ))
        )}
        <CtaButton
          label={instructing ? "직접 지시 닫기" : "✎ 직접 지시"}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setInstructing((value) => !value)}
        />
        <OpenAgentButton agent={agent} ctx={ctx} />
      </View>
      {instructing ? (
        <InstructionBox
          placeholder="에이전트에게 보낼 지시. 이 요청은 거절되고 지시가 함께 전달돼요."
          submitLabel="거절하고 지시 보내기"
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
    <CardFrame kind="에러" agent={agent} ctx={ctx}>
      <Section
        label="결정할 것"
        ctx={ctx}
        value={
          <>
            <Text style={{ color: ctx.theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
              {failedAgain
                ? "지시를 보낸 뒤에도 다시 에러로 멈췄어요."
                : "에러로 멈췄어요. 어떻게 이어갈지 지시해 주세요."}
            </Text>
            {failedAgain ? (
              <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>
                같은 지시로는 풀리지 않을 수 있어요. 에이전트를 열어 모델이나 설정을 확인해 주세요.
              </Text>
            ) : null}
          </>
        }
      />
      <Section label="에러" ctx={ctx} value={<CodeBox text={message ?? "에러 내용을 받지 못했어요."} ctx={ctx} maxHeight={200} />} />
      {history.length > 0 ? (
        <Section
          label="보낸 지시"
          ctx={ctx}
          value={history.slice(-3).map((item) => (
            <Text key={item.at} style={{ color: ctx.theme.colors.foreground, fontSize: 12 }}>
              {`${formatAgo(item.at, ctx.now)} · ${item.text}`}
            </Text>
          ))}
        />
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={instructing ? "직접 지시 닫기" : "✎ 직접 지시"}
          tone={failedAgain ? "neutral" : "primary"}
          disabled={send.isPending}
          theme={ctx.theme}
          onPress={() => setInstructing((value) => !value)}
        />
        <OpenAgentButton agent={agent} ctx={ctx} primary={failedAgain} />
      </View>
      {instructing ? (
        <InstructionBox
          placeholder="에이전트에게 보낼 다음 지시"
          submitLabel={send.isPending ? "보내는 중…" : "지시 보내기"}
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
    title: agent.title ?? "제목 없는 에이전트",
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
    <CardFrame kind="요청" agent={cardAgent} ctx={ctx}>
      <Text style={{ color: ctx.theme.colors.foreground }}>
        {directory.ready ? "대기 중인 요청을 읽지 못했어요. 에이전트를 열어서 확인해 주세요." : "대기 중인 요청을 읽는 중…"}
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
      <Text style={{ color, fontSize: 14, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: 14 }}>{String(count)}</Text>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>{hint}</Text>
    </View>
  );
}

/** 결정 인박스. 반응 필요는 카드에서 바로 처리하고, 확인 필요는 열어서 본다 (RULES.md §12). */
export function InboxView({ ctx }: { ctx: ViewContext }) {
  const classify = useClassifier();
  const needsReaction = (agent: PluginAgentSnapshot) => isVisibleAgent(agent) && classify.column(agent) === "react";
  const needsReview = (agent: PluginAgentSnapshot) => isVisibleAgent(agent) && classify.column(agent) === "review";
  const reacting = useAgents({ hosts: [ctx.hostId], where: needsReaction, orderBy: oldestFirst });
  const reviewing = useAgents({ hosts: [ctx.hostId], where: needsReview, orderBy: ["lastActivityAt", "desc"] });
  return (
    <View style={{ gap: 20, maxWidth: 880 }}>
      <View style={{ gap: 10 }}>
        <SectionHeader
          title="반응 필요"
          count={reacting.length}
          hint="작업이 멈춰서 나를 기다려요"
          color={columnColor("react", ctx.theme)}
          ctx={ctx}
        />
        {reacting.length === 0 ? (
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 13 }}>지금 멈춰 있는 작업이 없어요.</Text>
        ) : (
          reacting.map((ref) => <AgentDecisions key={ref.key} agentRef={ref} ctx={ctx} />)
        )}
      </View>
      <View style={{ gap: 10 }}>
        <SectionHeader
          title="확인 필요"
          count={reviewing.length}
          hint="작업은 끝났거나 계속되고, 나중에 봐도 돼요"
          color={columnColor("review", ctx.theme)}
          ctx={ctx}
        />
        {reviewing.length === 0 ? (
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 13 }}>확인할 결과가 없어요.</Text>
        ) : (
          reviewing.map((ref) => <AgentCard key={ref.key} agentRef={ref} ctx={ctx} />)
        )}
      </View>
    </View>
  );
}
