import { MessageData } from './types';

export type InvokeBeforeContext = {
    workspacePath: string;
    agentId: string;
    messageData: MessageData;
    message: string;
    isInternal: boolean;
    shouldReset: boolean;
};

export type InvokeAfterContext = {
    workspacePath: string;
    agentId: string;
    messageId: string;
    message: string;
    response: string;
    isInternal: boolean;
};

export type InvokeHookState = Record<string, unknown>;

export type InvokeBeforeResult = {
    message?: string;
    state?: unknown;
};

export type InvokeHookPlugin = {
    name: string;
    beforeInvoke?: (context: InvokeBeforeContext) => Promise<InvokeBeforeResult | void>;
    afterInvoke?: (context: InvokeAfterContext, state: unknown) => Promise<void>;
};

export type InvokeHookExecution = {
    message: string;
    state: InvokeHookState;
};

export async function runBeforeInvokeHooks(
    plugins: InvokeHookPlugin[],
    context: InvokeBeforeContext
): Promise<InvokeHookExecution> {
    let nextMessage = context.message;
    const state: InvokeHookState = {};

    for (const plugin of plugins) {
        if (!plugin.beforeInvoke) continue;
        const result = await plugin.beforeInvoke({ ...context, message: nextMessage });
        if (!result) continue;
        if (result.message !== undefined) {
            nextMessage = result.message;
        }
        if (result.state !== undefined) {
            state[plugin.name] = result.state as Record<string, unknown>;
        }
    }

    return { message: nextMessage, state };
}

export async function runAfterInvokeHooks(
    plugins: InvokeHookPlugin[],
    context: InvokeAfterContext,
    state: InvokeHookState
): Promise<void> {
    for (let i = plugins.length - 1; i >= 0; i -= 1) {
        const plugin = plugins[i];
        if (!plugin.afterInvoke) continue;
        await plugin.afterInvoke(context, state[plugin.name]);
    }
}
