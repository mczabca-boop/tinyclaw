import {
    prepareOpenVikingBeforeInvoke,
    finalizeOpenVikingAfterInvoke,
} from '../openviking-adapter';
import {
    InvokeBeforeContext,
    InvokeAfterContext,
    InvokeHookPlugin,
} from '../invoke-hooks';

type OpenVikingHookState = {
    openVikingSessionId: string | null;
    nativeSessionWriteFailed: boolean;
};

async function beforeInvoke(context: InvokeBeforeContext) {
    const result = await prepareOpenVikingBeforeInvoke({
        workspacePath: context.workspacePath,
        agentId: context.agentId,
        messageData: context.messageData,
        message: context.message,
        isInternal: context.isInternal,
        shouldReset: context.shouldReset,
    });

    const state: OpenVikingHookState = {
        openVikingSessionId: result.openVikingSessionId,
        nativeSessionWriteFailed: result.nativeSessionWriteFailed,
    };

    return {
        message: result.message,
        state,
    };
}

async function afterInvoke(
    context: InvokeAfterContext,
    rawState: unknown
): Promise<void> {
    const state = (rawState as OpenVikingHookState | undefined) || {
        openVikingSessionId: null,
        nativeSessionWriteFailed: false,
    };

    await finalizeOpenVikingAfterInvoke({
        workspacePath: context.workspacePath,
        agentId: context.agentId,
        messageId: context.messageId,
        message: context.message,
        response: context.response,
        isInternal: context.isInternal,
        openVikingSessionId: state.openVikingSessionId,
        nativeSessionWriteFailed: state.nativeSessionWriteFailed,
    });
}

export const openVikingInvokePlugin: InvokeHookPlugin = {
    name: 'openviking',
    beforeInvoke,
    afterInvoke,
};
