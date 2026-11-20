<template>
<TouchActionPanel
        :open="showTouchPanel"
        :server-groups="touchServerGroups"
        :state="touchGateState"
        :busy-actions="touchBusyActions"
        :hypnosis-badge="touchHypnosisBadge"
        :pending-count="touchPendingCount"
        :pending-by-mode="touchPendingByMode"
        :states="touchStates"
        @action="onTouchAction"
        @open="onTouchPanelOpen"
        @close="showTouchPanel = false"
      />

<ToyPanel
        :open="showToyPanel"
        :worn-toys="wornToys"
        :toy-options="toyOptions"
        @close="showToyPanel = false"
        @toy-equip="onToyEquip"
        @toy-intensity="onToyIntensity"
        @toy-remove="onToyRemove"
      />

<IntimateActionPanel
        :open="showIntimatePanel"
        :character-id="chat.activeCharId"
        @close="showIntimatePanel = false"
      />
</template>

<script setup>
import TouchActionPanel from '../../TouchActionPanel.vue'
import ToyPanel from '../../ToyPanel.vue'
import IntimateActionPanel from '../../IntimateActionPanel.vue'
import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
const { showTouchPanel, touchServerGroups, touchGateState, touchBusyActions, touchHypnosisBadge, touchPendingCount, touchPendingByMode, touchStates, onTouchAction, onTouchPanelOpen, showToyPanel, wornToys, toyOptions, onToyEquip, onToyIntensity, onToyRemove, showIntimatePanel, chat } = usePrivateChatContext()
</script>

<style scoped>
</style>
