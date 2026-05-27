import {
    eventSource,
    this_chid,
    characters,
    getRequestHeaders,
    event_types,
    animation_duration,
    animation_easing,
    unshallowCharacter,
    substituteParams,
    itemizedPrompts,
    loadItemizedPrompts,
    getUserAvatar,
    getUserAvatars,
    // settings,
    replaceItemizedPromptText,
} from '../../../../script.js';
import { groups, selected_group } from '../../../group-chats.js';
import { loadFileToDocument, delay, getBase64Async, getSanitizedFilename, saveBase64AsFile, getFileExtension, getVideoThumbnail, clamp, getCharIndex } from '../../../utils.js';
import { loadMovingUIState } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { DragAndDropHandler } from '../../../dragdrop.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { t, translate } from '../../../i18n.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { deleteMediaFromServer } from '../../../chats.js';
import { MEDIA_REQUEST_TYPE, VIDEO_EXTENSIONS } from '../../../constants.js';
import { ContextMenu } from '../../quick-reply/src/ui/ctx/ContextMenu.js';
import { setOpenAIMessages, oai_settings, loadOpenAISettings } from '../../../openai.js';
import { user_avatar, autoSelectPersona } from '../../../personas.js';

const { extensionSettings, saveSettingsDebounced, renderExtensionTemplateAsync } = SillyTavern.getContext();
export { MODULE_NAME };

const MODULE_NAME = 'letta';

const defaultSettings = {
    sync_n_messages: 50,
};

if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
}

const settings = extensionSettings[MODULE_NAME];

// const settings = defaultSettings;


// TODO provide settings for connecting to different letta endpoints.
// Would have to rember secret API key

export async function init() {


    const settingsHtml = await renderExtensionTemplateAsync(
    'third-party/letta',
    'settings',
    {
        title: 'Letta',
        version: '1.0',
        sync_n_messages: settings.sync_n_messages,
    }
    );

    // Append to the extensions settings panel
    $('#extensions_settings2').append(settingsHtml);
    
    $('#letta_sync_n_messages').on('input', function () {
        settings.sync_n_messages = Number($(this).val());
        saveSettingsDebounced();
    });

    const sync_n_messages = settings.sync_n_messages;
    console.log('sync_n_messages:', sync_n_messages);

    console.log('-------- Letta Glue Init --------');

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, async function () {
        await updateCharacterLetta();
    });

    eventSource.on(event_types.CHARACTER_RENAMED, async function (args) {
        await deleteCharacter(args);
    });

    eventSource.on(event_types.CHARACTER_EDITED, async function () {
        await updateCharacterLetta();
    });
    
    eventSource.on(event_types.CHARACTER_DELETED, async function (args) {
        await deleteCharacter(args[0]);
    });

    eventSource.on(event_types.CHAT_DELETED, async function (args) {
        await deleteChat(args);
    });

    eventSource.on(event_types.CHAT_LOADED, async function () {
        await loadChatLetta();
    });

    // eventSource.on(event_types.CHAT_CREATED, async function () {
    //     await loadChatLetta();
    // });

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async function () {
        await updatePromptLetta();
    });

    // eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, async function () {
    //     await loadChatLetta();
    // });

    eventSource.on(event_types.MESSAGE_UPDATED, async function () {
        await editLetta(sync_n_messages);
    });

    eventSource.on(event_types.MESSAGE_DELETED, async function () {
        await editLetta(sync_n_messages);
    });

    eventSource.on(event_types.MESSAGE_SWIPED, async function () {
        await editLetta(sync_n_messages);
    });

    eventSource.on(event_types.GENERATION_STOPPED, async function () {
        await editLetta(sync_n_messages);
    });
}

var stash_characterId = "";

/**
 * @param {any} characterId
 * @param {any} characters
 */
async function getCharacter(characterId, characters){
    await unshallowCharacter(characterId);

    const character = characters[Number(characterId)];
    if (!character) {
        console.warn(`Character with ID ${characterId} not found.`);
        return;
    }

    stash_characterId = characterId;

    return character;
}

/**
 * Update or create the current character in Letta
**/
const LETTA_AGENT_TYPES = Object.freeze({
    MEMGPT: "memgpt_agent",
    MEMGPT_V2: "memgpt_v2_agent",
    LETTA_V1: "letta_v1_agent",
    REACT: "react_agent",
    WORKFLOW: "workflow_agent",
    SPLIT_THREAD: "split_thread_agent",
    SLEEPTIME: "sleeptime_agent",
    VOICE_CONVO: "voice_convo_agent",
    VOICE_SLEEPTIME: "voice_sleeptime_agent",
});

async function updateCharacterLetta() {
    const {characterId, characters, chatMetadata, mainApi, chatCompletionSettings, saveMetadata} = SillyTavern.getContext();
    const character = await getCharacter(characterId, characters);
    if(!character) return false;

    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/update_character', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            agent_id: chatMetadata.letta_agent_id,
            characterId: character.avatar,
            character_json: character.json_data,
            model_settings: {
                ...oai_settings, // This has a lot of data that should be stripped out
                provider_type: mainApi,
                max_output_tokens: oai_settings.openai_max_tokens,
                embedding: "openai/text-embedding-3-small" 
            },
            agent_settings: {
                agent_type: LETTA_AGENT_TYPES.LETTA_V1,
                model: 'openai-proxy/' + chatCompletionSettings.custom_model,
                context_window_limit: oai_settings.openai_max_context,
                // system: '', // This gets overwritten anyway.
            },
        })
    });
    if(!response.ok){
        return false;
    }

    chatMetadata.letta_agent_id = (await response.json()).agent_id;
    saveMetadata();

    console.log('Updated character letta.');
    return true;
}

/**
 * returns letta agent ID found by ST character ID.
 * @param {string} characterId
**/
async function getCharacterLetta(characterId) {
    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/get_character', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            characterId: characterId
        })
    });
    if(!response.ok){
        return false;
    }

    return (await response.json()).agent_id;
}

/**
 * returns letta conversation ID found by ST chat ID (title)
 * @param {string} agent_id
 * @param {string} title
**/
async function getChatLetta(agent_id, title) {
    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/get_chat', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            agent_id: agent_id,
            title: title
        })
    });
    if(!response.ok){
        return null;
    }

    return (await response.json()).conversation_id;
}


/**
 * Prepares the server with extra information before messaging.
 * letta_agent_id and letta_conversation_id are set in ST chat metadata
**/
async function loadChatLetta() {
    const {chatMetadata, chatId, saveMetadata} = SillyTavern.getContext();

    if(!chatMetadata.letta_agent_id) updateCharacterLetta();
    
    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/load_chat', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            agent_id: chatMetadata.letta_agent_id,
            conversation_id: chatMetadata.letta_conversation_id,
            title: chatId,
            streaming: true,
            stream_tokens: true,
            n_messages: 1,
        })
    });

    if(!response.ok){
        return false;
    }

    chatMetadata.letta_conversation_id = (await response.json()).conversation_id;
    saveMetadata();

    console.log('Registered Letta Conversation: ' +  chatMetadata.letta_conversation_id);
    return true;
}

async function updatePromptLetta() {
    const {chatMetadata} = SillyTavern.getContext();
    const agent_id = chatMetadata.letta_agent_id;
    if(!agent_id) return false;

    const prompts_processed = oai_settings.prompts.map((prompt) => {
        if (!prompt) return prompt;

        return {
            ...prompt,
            content: prompt.content ? substituteParams(prompt.content) : prompt.content
        };
    });

    if(!prompts_processed) return false;

    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/update_prompt', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            agent_id: agent_id,
            prompts: prompts_processed,
            prompt_order: oai_settings.prompt_order
        })
    });
    if(!response.ok){
        return false
    }
    console.log('Updated prompt letta.');
    return true;
}

/**
 * Clears the letta conversation history and copies the current content into letta's conversation buffer.
 * @param {number | null} sync_n_messages Number of messages back to copy into letta memory.
*/
async function editLetta(sync_n_messages){
    const {chatMetadata, saveMetadata} = SillyTavern.getContext();

    if(!chatMetadata.letta_agent_id) await updateCharacterLetta();
    if(!chatMetadata.letta_conversation_id) await loadChatLetta();
    
    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/edit', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            agent_id: chatMetadata.letta_agent_id,
            conversation_id: chatMetadata.letta_conversation_id,
            n_messages: sync_n_messages,
        })
    });

    if(!response.ok){
        return false;
    }

    chatMetadata.letta_conversation_id = (await response.json()).conversation_id;
    saveMetadata();

    console.log('Registered Letta Conversation: ' +  chatMetadata.letta_conversation_id);
    return true;
}


/**
 * @param {string} characterId ST character ID
*/
async function deleteCharacter(characterId){
    const agent_id = await getCharacterLetta(characterId);

    const confirm = new Popup(`Delete Letta Character?\n Letta ID: ${agent_id}`, POPUP_TYPE.CONFIRM);
    if(!await confirm.show()) return false;

    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/delete_character', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            agent_id: agent_id,
        })
    });

    if(!response.ok){
        return false;
    }

    console.log('Deleted Letta Character: ' +  agent_id);
    return true;
}

/**
 * @param {string} chatId ST chat Id
*/
async function deleteChat(chatId){
    const {chatMetadata, characters} = SillyTavern.getContext();
    const characterId = characters[Number(stash_characterId)].avatar;
    const agent_id = chatMetadata.letta_agent_id ?? await getCharacterLetta(characterId); // retrieve the last set character

    const conversation_id = await getChatLetta(agent_id, chatId);
    if(!conversation_id) return false;
    
    const baseHeaders = getRequestHeaders();
    const response = await fetch('/api/plugins/letta-plugin/delete_chat', {
        method: 'POST',
        headers: Object.assign(baseHeaders, {
                'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
            conversation_id: conversation_id,
        })
    });

    if(!response.ok){
        return false;
    }

    console.log('Deleted Letta Chat: ' +  conversation_id);
    return true;
}