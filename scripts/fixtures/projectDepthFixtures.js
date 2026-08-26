export function makeCompleteDepthStory(id = 'depth-story') {
  return {
    id,
    type: 'story',
    name: 'Histoire au fond',
    audio: '/fixtures/story.mp3',
    itemAudio: '/fixtures/story-title.mp3',
    itemImage: '/fixtures/story.png',
    silentTitleStage: false,
    autoGenerateImage: false,
    individualOptions: {},
    controlSettings: {
      autoplay: false,
      wheel: false,
      pause: true,
      ok: true,
      home: true,
    },
    returnAfterPlay: 'root',
    returnOnHome: 'root',
    titleReturnOnHome: 'root',
    titleControlSettings: {
      autoplay: false,
      wheel: true,
      pause: false,
      ok: true,
      home: true,
    },
    afterPlaybackPromptAudio: '/fixtures/end-prompt.mp3',
    afterPlaybackPromptControlSettings: {
      autoplay: true,
      wheel: false,
      pause: false,
      ok: true,
      home: true,
    },
    afterPlaybackPromptOkTarget: 'root',
    afterPlaybackPromptHomeTarget: 'root',
    afterPlaybackSequence: [{
      id: 'depth-end-step',
      name: 'Fin complète',
      audio: '/fixtures/end-step.mp3',
      image: '/fixtures/end-step.png',
      controlSettings: {
        autoplay: true,
        wheel: false,
        pause: false,
        ok: true,
        home: true,
      },
      okTarget: 'root',
      okChoiceTargets: [],
      homeTarget: 'root',
      homeFollowsOk: false,
      homeNone: false,
    }],
    afterPlaybackHomeStep: {
      id: 'depth-home-step',
      name: 'Retour complet',
      audio: '/fixtures/home-step.mp3',
      image: '/fixtures/home-step.png',
      controlSettings: {
        autoplay: true,
        wheel: false,
        pause: false,
        ok: true,
        home: true,
      },
      okTarget: 'root',
      okChoiceTargets: [],
      homeTarget: 'root',
      homeFollowsOk: false,
      homeNone: false,
    },
  };
}

export function makeNestedMenuChain(depth, leaf = makeCompleteDepthStory()) {
  let children = [leaf];
  for (let level = depth; level >= 1; level -= 1) {
    children = [{
      id: `folder-${level}`,
      type: 'menu',
      name: `Dossier ${level}`,
      audio: `/fixtures/folder-${level}.mp3`,
      image: `/fixtures/folder-${level}.png`,
      autoBlackImage: false,
      autoGenerateImage: false,
      individualOptions: {},
      controlSettings: {
        autoplay: false,
        wheel: true,
        pause: false,
        ok: true,
        home: true,
      },
      returnAfterPlay: 'root',
      returnOnHome: 'root',
      children,
    }];
  }
  return children;
}

export function makeDepthProject(depth, { withSiblingBranch = false } = {}) {
  const rootEntries = makeNestedMenuChain(depth);
  if (withSiblingBranch) {
    rootEntries.push({
      id: 'shallow-folder',
      type: 'menu',
      name: 'Branche courte',
      audio: '/fixtures/shallow.mp3',
      image: '/fixtures/shallow.png',
      children: [makeCompleteDepthStory('shallow-story')],
    });
  }
  return {
    schemaVersion: 3,
    version: 2,
    projectName: `Fixture profondeur ${depth}`,
    projectType: 'pack',
    rootName: 'Menu racine',
    endNodeName: 'Message de fin',
    rootAudio: '/fixtures/root.mp3',
    rootImage: '/fixtures/root.png',
    thumbnailImage: '/fixtures/root.png',
    sameImage: true,
    nightModeAudio: null,
    nightModeReturn: null,
    nightModeHomeReturn: null,
    nativeGraph: null,
    packMetadata: {
      title: `Fixture profondeur ${depth}`,
      author: 'Story Studio',
      version: 1,
      minAge: '3',
      producer: '',
      bonus: '',
      description: '',
      uuid: '',
      originalUuid: '',
      namingMode: 'convention',
      legacyExportName: '',
      legacyName: '',
    },
    globalOptions: {
      silenceMode: 'off',
      harmonizeLoudness: false,
      autoNext: false,
      nightMode: false,
      endMessageAutoplay: false,
      endNode: false,
      aiImageGen: false,
    },
    rootEntries,
  };
}
