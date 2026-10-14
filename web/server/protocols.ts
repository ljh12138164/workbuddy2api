import { array, object, type ObjectValue } from './upstream';

export type Protocol = 'chat' | 'responses' | 'anthropic';

function textContent(value: unknown): unknown {
  if (typeof value === 'string') return value;
  return array(value).map(item => {
    const part = object(item);
    if (['text', 'input_text', 'output_text'].includes(String(part.type))) return { type: 'text', text: String(part.text ?? '') };
    if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url } };
    if (part.type === 'image') {
      const source = object(part.source);
      return { type: 'image_url', image_url: { url: source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url } };
    }
    if (part.type === 'image_url') return part;
    return null;
  }).filter(Boolean);
}

export function toChat(input: ObjectValue, protocol: Protocol): ObjectValue {
  if (protocol === 'chat') return { ...input, stream_options: input.stream ? { include_usage: true } : undefined };
  const messages: ObjectValue[] = [];
  if (protocol === 'responses') {
    if (input.previous_response_id) throw new Error('请传入完整对话历史；当前网关不保存 Responses 会话');
    if (input.instructions) messages.push({ role: 'system', content: input.instructions });
    if (typeof input.input === 'string') messages.push({ role: 'user', content: input.input });
    for (const value of array(input.input)) {
      const item = object(value);
      if (item.type === 'function_call') {
        const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
        const previous = messages.at(-1);
        if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      }
      else if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
      else if (!item.type || item.type === 'message') messages.push({ role: item.role === 'developer' ? 'system' : item.role || 'user', content: textContent(item.content) });
      else if (item.type !== 'reasoning') throw new Error(`暂不支持 Responses 输入类型 ${item.type}`);
    }
  } else {
    if (input.system) messages.push({ role: 'system', content: textContent(input.system) });
    for (const value of array(input.messages)) {
      const message = object(value);
      if (typeof message.content === 'string') { messages.push(message); continue; }
      const parts = array(message.content).map(object);
      const tools = parts.filter(part => part.type === 'tool_use').map(part => ({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } }));
      const content = textContent(parts.filter(part => ['text', 'image'].includes(String(part.type))));
      for (const part of parts.filter(part => part.type === 'tool_result')) {
        messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: textContent(part.content) });
      }
      if (array(content).length || tools.length) messages.push({ role: message.role, content: array(content).length ? content : null, ...(tools.length ? { tool_calls: tools } : {}) });
    }
  }
  const tools = array(input.tools).map(value => {
    const tool = object(value);
    if (protocol === 'responses' && tool.type !== 'function') throw new Error('当前网关只支持 function 工具，请在客户端执行其他工具');
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: protocol === 'anthropic' ? tool.input_schema : tool.parameters, strict: tool.strict } };
  });
  const choice = object(input.tool_choice);
  const toolChoice = typeof input.tool_choice === 'string' ? input.tool_choice : choice.type === 'tool' || choice.type === 'function' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type === 'auto' ? 'auto' : choice.type === 'none' ? 'none' : undefined;
  return {
    model: input.model, messages, tools: tools.length ? tools : undefined, tool_choice: toolChoice,
    stream: input.stream === true, max_tokens: input.max_tokens ?? input.max_output_tokens,
    temperature: input.temperature, top_p: input.top_p, stop: input.stop_sequences,
    reasoning_effort: object(input.reasoning).effort,
    stream_options: input.stream ? { include_usage: true } : undefined,
  };
}

export function fromChat(chat: ObjectValue, protocol: Protocol, responseId = `resp_${crypto.randomUUID()}`): ObjectValue {
  if (protocol === 'chat') return chat;
  const choice = object(array(chat.choices)[0]);
  const message = object(choice.message);
  const usage = object(chat.usage);
  const tools = array(message.tool_calls).map(object);
  if (protocol === 'anthropic') {
    const content: ObjectValue[] = [];
    if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
    for (const tool of tools) {
      const fn = object(tool.function);
      content.push({ type: 'tool_use', id: tool.id, name: fn.name, input: JSON.parse(String(fn.arguments || '{}')) });
    }
    return { id: responseId.replace('resp_', 'msg_'), type: 'message', role: 'assistant', model: chat.model, content,
      stop_reason: tools.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: Number(usage.prompt_tokens || 0), output_tokens: Number(usage.completion_tokens || 0) } };
  }
  const output: ObjectValue[] = [];
  if (typeof message.content === 'string' && message.content) output.push({ id: `${responseId}_message`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  for (const tool of tools) {
    const fn = object(tool.function);
    output.push({ id: `fc_${tool.id}`, type: 'function_call', status: 'completed', call_id: tool.id, name: fn.name, arguments: fn.arguments });
  }
  return { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: choice.finish_reason === 'length' ? 'incomplete' : 'completed',
    incomplete_details: choice.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null, error: null, model: chat.model, output,
    usage: { input_tokens: Number(usage.prompt_tokens || 0), output_tokens: Number(usage.completion_tokens || 0), total_tokens: Number(usage.total_tokens || 0) } };
}

export async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('上游流事件超出限制');
      // Keep incomplete CRLF pairs intact until the next read.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export interface Usage { input: number; output: number }

// Emit real incremental deltas; retain only the current assistant response.
export async function* translateStream(body: ReadableStream<Uint8Array>, protocol: Protocol, model: string, usage: Usage) {
  const id = `resp_${crypto.randomUUID()}`;
  let sequence = 0, content = '', finish = 'stop', started = false, ended = false;
  const calls = new Map<number, { id: string; name: string; arguments: string; outputIndex: number; started: boolean }>();
  let messageIndex: number | null = null, nextIndex = 0;
  const emit = (type: string, data: ObjectValue) => `event: ${type}\ndata: ${JSON.stringify(protocol === 'responses' ? { type, sequence_number: sequence++, ...data } : { type, ...data })}\n\n`;
  const messageId = `${id}_message`;
  const messageItem = (text: string, status: string) => ({ id: messageId, type: 'message', role: 'assistant', status, content: text ? [{ type: 'output_text', text, annotations: [] }] : [] });
  const callItem = (call: { id: string; name: string; arguments: string }, status: string) => ({ id: `fc_${call.id}`, type: 'function_call', status, call_id: call.id, name: call.name, arguments: call.arguments });
  for await (const data of sseData(body)) {
    if (data === '[DONE]') { ended = true; break; }
    const chunk = object(JSON.parse(data));
    if (chunk.error || (chunk.code !== undefined && Number(chunk.code) !== 0)) throw new Error('上游流返回错误');
    const observed = object(chunk.usage);
    if (observed.prompt_tokens !== undefined) usage.input = Number(observed.prompt_tokens);
    if (observed.completion_tokens !== undefined) usage.output = Number(observed.completion_tokens);
    if (protocol === 'chat') { yield `data: ${data}\n\n`; continue; }
    if (!started) {
      started = true;
      if (protocol === 'responses') yield emit('response.created', { response: { id, object: 'response', status: 'in_progress', model, output: [] } });
      else yield emit('message_start', { message: { id: id.replace('resp_', 'msg_'), type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 0 } } });
    }
    const choice = object(array(chunk.choices)[0]), delta = object(choice.delta);
    if (choice.finish_reason) finish = String(choice.finish_reason);
    if (typeof delta.content === 'string' && delta.content) {
      if (messageIndex === null) {
        messageIndex = nextIndex++;
        if (protocol === 'responses') {
          yield emit('response.output_item.added', { output_index: messageIndex, item: messageItem('', 'in_progress') });
          yield emit('response.content_part.added', { item_id: messageId, output_index: messageIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        } else yield emit('content_block_start', { index: messageIndex, content_block: { type: 'text', text: '' } });
      }
      if (content.length + delta.content.length > 4 * 1024 * 1024) throw new Error('转换后的响应超出限制');
      content += delta.content;
      yield protocol === 'responses' ? emit('response.output_text.delta', { item_id: messageId, output_index: messageIndex, content_index: 0, delta: delta.content }) : emit('content_block_delta', { index: messageIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const value of array(delta.tool_calls)) {
      const tool = object(value), fn = object(tool.function), index = Number(tool.index ?? 0);
      let call = calls.get(index);
      if (!call) { call = { id: '', name: '', arguments: '', outputIndex: nextIndex++, started: false }; calls.set(index, call); }
      if (typeof tool.id === 'string') call.id += tool.id;
      if (typeof fn.name === 'string') call.name += fn.name;
      if (!call.started && call.id && call.name) {
        call.started = true;
        if (protocol === 'responses') yield emit('response.output_item.added', { output_index: call.outputIndex, item: callItem({ ...call, arguments: '' }, 'in_progress') });
        else yield emit('content_block_start', { index: call.outputIndex, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
        if (call.arguments) yield protocol === 'responses' ? emit('response.function_call_arguments.delta', { item_id: `fc_${call.id}`, output_index: call.outputIndex, delta: call.arguments }) : emit('content_block_delta', { index: call.outputIndex, delta: { type: 'input_json_delta', partial_json: call.arguments } });
      }
      if (typeof fn.arguments === 'string') {
        if (call.arguments.length + fn.arguments.length > 4 * 1024 * 1024) throw new Error('工具参数超出限制');
        call.arguments += fn.arguments;
        if (call.started) yield protocol === 'responses' ? emit('response.function_call_arguments.delta', { item_id: `fc_${call.id}`, output_index: call.outputIndex, delta: fn.arguments }) : emit('content_block_delta', { index: call.outputIndex, delta: { type: 'input_json_delta', partial_json: fn.arguments } });
      }
    }
  }
  if (!ended) throw new Error('上游流提前结束');
  if (protocol === 'chat') { yield 'data: [DONE]\n\n'; return; }
  if (messageIndex !== null) {
    if (protocol === 'responses') {
      const part = { type: 'output_text', text: content, annotations: [] };
      yield emit('response.output_text.done', { item_id: messageId, output_index: messageIndex, content_index: 0, text: content });
      yield emit('response.content_part.done', { item_id: messageId, output_index: messageIndex, content_index: 0, part });
      yield emit('response.output_item.done', { output_index: messageIndex, item: messageItem(content, 'completed') });
    } else yield emit('content_block_stop', { index: messageIndex });
  }
  for (const call of calls.values()) {
    if (!call.started) throw new Error('上游工具调用缺少 id 或名称');
    if (protocol === 'responses') {
      yield emit('response.function_call_arguments.done', { item_id: `fc_${call.id}`, output_index: call.outputIndex, arguments: call.arguments });
      yield emit('response.output_item.done', { output_index: call.outputIndex, item: callItem(call, 'completed') });
    } else yield emit('content_block_stop', { index: call.outputIndex });
  }
  if (protocol === 'responses') {
    const result = fromChat({ model, choices: [{ message: { content, tool_calls: [...calls.values()].map(call => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) }, finish_reason: finish }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } }, protocol, id);
    // The completed snapshot must retain the same output order as delta events.
    const outputs = [...(messageIndex === null ? [] : [{ index: messageIndex, item: messageItem(content, 'completed') }]), ...[...calls.values()].map(call => ({ index: call.outputIndex, item: callItem(call, 'completed') }))];
    result.output = outputs.sort((a, b) => a.index - b.index).map(value => value.item);
    yield emit(result.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: result });
  } else {
    yield emit('message_delta', { delta: { stop_reason: calls.size ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { input_tokens: usage.input, output_tokens: usage.output } });
    yield emit('message_stop', {});
  }
}
