<template>
  <DeviceAccessGate>
    <router-view v-if="route.meta.standingDisplay" />
    <App v-else />
  </DeviceAccessGate>
</template>
<script setup>
import { useRoute } from 'vue-router'
import App from './App.vue'
import DeviceAccessGate from './components/DeviceAccessGate.vue'
const route = useRoute()
</script>
