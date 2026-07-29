export interface RecommendedSkillDefinition {
	id: string;
	name: string;
	skillName: string;
	description: string;
	packageSource: string;
	sourceKind: "npm" | "git" | "url" | "local";
	publisher: "first-party" | "community";
	openUrl?: string;
	setupHint?: string;
}

export const RECOMMENDED_SKILLS: RecommendedSkillDefinition[] = [
	{
		id: "creatorskill",
		name: "Creator Skill",
		skillName: "creatorskill",
		description: "根据简短描述创建或更新提示词模板和 Agent 技能。命令会先放入聊天中，不会自动执行。",
		packageSource: "local:creatorskill",
		sourceKind: "local",
		publisher: "first-party",
	},
	{
		id: "brave-search",
		name: "Brave Search",
		skillName: "brave-search",
		description: "通过 Brave Search API 进行网页搜索和内容提取。",
		packageSource: "git:https://github.com/badlogic/pi-skills",
		sourceKind: "git",
		publisher: "first-party",
		openUrl: "https://github.com/badlogic/pi-skills/tree/main/brave-search",
		setupHint: "首次使用前，请设置 BRAVE_API_KEY 并在技能目录中运行 npm install。",
	},
	{
		id: "browser-tools",
		name: "Browser Tools",
		skillName: "browser-tools",
		description: "通过 Chrome DevTools Protocol 进行交互式浏览器自动化。",
		packageSource: "git:https://github.com/badlogic/pi-skills",
		sourceKind: "git",
		publisher: "first-party",
		openUrl: "https://github.com/badlogic/pi-skills/tree/main/browser-tools",
		setupHint: "先在技能目录中运行 npm install，需要时以远程调试模式启动 Chrome。",
	},
	{
		id: "youtube-transcript",
		name: "YouTube Transcript",
		skillName: "youtube-transcript",
		description: "获取 YouTube 视频的字幕文本，用于总结和分析。",
		packageSource: "git:https://github.com/badlogic/pi-skills",
		sourceKind: "git",
		publisher: "first-party",
		openUrl: "https://github.com/badlogic/pi-skills/tree/main/youtube-transcript",
		setupHint: "在技能目录中运行 npm install；视频需带有可用的字幕。",
	},
];
