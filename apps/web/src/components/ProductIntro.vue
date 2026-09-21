<script setup lang="ts">
import { computed } from "vue";

import englishPoster from "../assets/intro/cfkanban-intro-en.jpg";
import englishVideo from "../assets/intro/cfkanban-intro-en.mp4";
import chinesePoster from "../assets/intro/cfkanban-intro-zh-CN.jpg";
import chineseVideo from "../assets/intro/cfkanban-intro-zh-CN.mp4";
import { locale } from "../lib/i18n";

const intro = computed(() => locale.value === "zh-CN" ? {
  title: "从一句话，到有迹可循的工作。",
  video: chineseVideo,
  poster: chinesePoster,
} : {
  title: "From conversation to tracked work.",
  video: englishVideo,
  poster: englishPoster,
});
</script>

<template>
  <section class="product-intro" aria-labelledby="product-intro-title">
    <h2 id="product-intro-title">{{ intro.title }}</h2>
    <video
      :key="locale"
      :src="intro.video"
      :poster="intro.poster"
      :aria-label="intro.title"
      controls
      playsinline
      preload="none"
      width="1920"
      height="1080"
    />
  </section>
</template>

<style scoped>
.product-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
  padding: 32px 0 40px;
}

.product-intro h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(1.4rem, 2.4vw, 1.9rem);
  font-weight: 600;
  line-height: 1.3;
  text-wrap: balance;
}

:lang(zh-CN) .product-intro h2 {
  font-family: var(--font-ui);
}

video {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}

@media (max-width: 760px) {
  .product-intro {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
    padding: 28px 0 32px;
  }

}
</style>
