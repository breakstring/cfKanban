<script setup lang="ts">
import UApp from "@nuxt/ui/components/App.vue";
import { en, zh_cn } from "@nuxt/ui/locale";
import { locale } from "../lib/i18n";
</script>

<template>
  <UApp :locale="locale === 'zh-CN' ? zh_cn : en" :toaster="null"><slot /></UApp>
</template>
