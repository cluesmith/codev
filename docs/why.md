# Why We Created Codev: From Theory to Practice

Waleed Kadous, Amr Elsayed

**TL;DR**: We previously [argued](https://medium.com/@waleedk/natural-language-is-now-code-35e9b3379d42) that natural language has become our new high-level programming language. We've now developed Codev, a repository that embodies this principle. While "vibe coding" throws away the source conversation, Codev treats specifications as durable, executable programs. Using our SP(IDE)R protocol (a structured sequence of steps with both human review and multi-agent consultation), we built a todo app where the same AI model produced a basic demo with conversational prompting but achieved 100% of the specified functionality with comprehensive tests using SP(IDE)R. We did not directly edit the source code, but we still have all the characteristics of a well-engineered software project: reliable application, comprehensive tests, clear architecture, and thorough documentation.

## The Journey to Codev

You can see a particular trajectory in our writing about using agents for coding. ["Natural Language is Now Code"](https://medium.com/@waleedk/natural-language-is-now-code-35e9b3379d42) argued that natural language has become the new high-level programming language. ["Good context leads to good code"](https://blog.stockapp.com/good-context-good-code/) showed how we built an AI-native engineering culture at StockApp. These articles explored the theory but didn't provide a complete system.

Meanwhile, we watched teams struggle to find a middle path between tech-debt inducing vibe coding and taking advantage of AI in a structured way. They knew conversational coding was risky, but formal methodologies felt heavyweight and slow.

We needed to translate these ideas into a practical system: installable in an afternoon, adoptable incrementally. Not another framework to learn, but a methodology supported by simple tooling that makes conversations durable, versioned, and executable.

This brought us to Codev: **Co**-development between humans and agents, driven by **Co**ntext as first-class code. We codified this into our first protocol SP(IDE)R (Specify, Plan, Implement, Defend, Evaluate, Review): a lightweight approach that treats natural language specifications as versioned, executable source code. In practice, your conversation becomes a living spec checked into git and enforced by CI. Nothing ephemeral determines behavior anymore.

## The SP(IDE)R Protocol

The SP(IDE)R protocol structures the creation of a shared context between the agents and the human.

**Specify**: The human and agents work together to align on a specification. Claude takes a first shot at transforming your request into concrete acceptance criteria, then gets reviews from other agents (Gemini 3 Pro and GPT-5). These agents might identify missing requirements, security concerns, or architectural considerations. Claude then comes back to the human with remaining open questions and design choices. This collaborative specification is stored in `codev/specs/####-feature-name.md`.

**Plan**: Claude proposes how to break down the implementation into phases, with clear deliverables and exit criteria. Again, other agents review: one might suggest a different sequencing, another might identify missing test considerations. The human has final review and can request changes. Any differences of opinion between agents are captured in the discussion. This plan is stored in `codev/plans/####-feature-name.md`.

Then for each phase, you run the **IDE loop**:
- **Implement**: Build the code for that phase
- **Defend**: Write comprehensive tests that prove it works. We use "Defend" rather than "Test" because it's not just about validation; it's about building defensive barriers that prevent the AI from introducing regressions or taking shortcuts in future iterations.
- **Evaluate**: Verify it meets the specification and take a moment to reflect: Did we overmock the tests? Is the code overly complex? Are we solving the right problem?

**Review** (or Refine/Revise/Reflect): After all phases complete, document what you learned. What worked? What didn't? These lessons feed forward into the next feature. But here's the key: you also update the SP(IDE)R protocol itself based on what you learned. The methodology evolves with your project. This review is captured in `codev/reviews/####-feature-name.md`.

The key differentiator is multi-agent consultation and fixed human review points. After writing the specification, we don't just proceed: we bring in multiple AI agents (GPT-5 and Gemini 3 Pro in our case) to review from different perspectives. One might catch security issues, another might spot performance problems. This happens again after implementation and testing. Each agent brings its own strengths and blind spots, as does the human who has final say at key decision points.

## The Todo Manager Case Study

To test SP(IDE)R, we ran an experiment. Same AI model (Claude Opus 4.1), same tools available. The only difference: methodology.

The request was to build a modern web-based todo manager with both traditional UI and conversational interface.

### Without SP(IDE)R

First attempt: conversational approach. Looking at the resulting codebase in [`todo-manager-vibe/`](https://github.com/ansari-project/todo-manager-vibe), the AI did produce a working application:
- Next.js 14 with TypeScript
- Flat file storage using JSON files
- Basic CRUD API routes
- TodoList and TodoItem components
- A ConversationalInterface component
- Toggle between list and chat views

However, critical gaps remain:
- **No tests whatsoever** - zero validation of functionality
- **Flat file storage with concurrency issues** - uses simple JSON files that will corrupt under concurrent access
- **No error handling** - API routes don't handle edge cases
- **No data validation** - accepts any input without verification
- **Minimal conversational interface** - basic UI but no actual natural language processing
- **No documentation** - no specs, plans, or architectural decisions recorded

The AI built something that looks good but didn't work. It used regexes for parsing the English. It put the conversational interface and the todo list on separate tabs. Without structured phases and review cycles, it optimized for "looks like it works" rather than "actually works reliably."

### With SP(IDE)R

Using SP(IDE)R, the specification phase expanded that prompt into concrete requirements. The plan broke it into five phases, each with its own IDE loop. You can explore the full implementation at [`todo-manager-spider`](https://github.com/ansari-project/todo-manager-spider).

After multi-agent consultation and human review of the spec and plan stages, systematic implementation produced:
- 32 source files with clear architecture
- All specified functionality working
- Test coverage across 5 suites
- SQLite database with migrations (later simplified for Vercel deployment)
- RESTful API with CRUD operations
- React components with state management
- Conversational interface via MCP (Model Context Protocol)
- Type safety throughout

Most importantly, we deployed the application. The app went through four iterations, including a significant refactor to make it work on Vercel's serverless infrastructure. Each iteration was documented in the reviews, creating a clear evolution trail.

### What We Learned

The review document ([`codev/reviews/0001-todo-manager.md`](https://github.com/ansari-project/todo-manager-spider/blob/main/codev/reviews/0001-todo-manager.md)) revealed important lessons. The AI documented where it had skipped IDE loops in early phases. It noted how multi-agent consultation caught deployment issues. The specification had started over-engineered and was simplified based on feedback. 

Most importantly, these lessons updated the protocol itself. Each project makes the methodology better.

### Working Without Source Code

We never directly looked at or edited the source code. Not once.

This wasn't a goal or experiment - it simply wasn't necessary. With properly fleshed out specifications, detailed plans, comprehensive tests, and defensive mechanisms, the AI stayed on track effectively. The implementation became a verified compilation artifact of our natural language specifications.

When issues arose (deployment failures, test gaps), we addressed them at the specification or plan level, not by diving into code. The higher-level artifacts contained all the information needed to guide corrections.

## Limitations and Current Reality

SP(IDE)R has real constraints worth acknowledging.

**Agent Compliance**: Current AI models sometimes struggle with multi-step protocols. They may skip steps or need reminders to follow the IDE loop. The human must supervise carefully and call out the agent when it breaks protocol. This improves with each model generation but today requires active oversight.

**Initial Friction**: Teams need time to see the value. The structure feels heavy compared to conversational coding until the first time they need to revisit or modify a feature.

**Scope Considerations**: Quick fixes and small scripts don't need the full protocol. SP(IDE)R shines for features that will need maintenance, documentation, and evolution.

**Tool Dependencies**: Full multi-agent consultation requires Claude Code with MCP support. SP(IDE)R-SOLO works without these but loses the multi-perspective review benefits.

### Comparisons with Other Specification-Driven Approaches

**vs Amazon Kiro**: Both approaches use structured specification files, with Kiro implementing EARS (Easy Approach to Requirements Syntax) from Rolls-Royce for formal requirements. Kiro uses three files (requirements.md, design.md, tasks.md) while SP(IDE)R uses specs, plans, and reviews. Key difference: Kiro is a full IDE with built-in hooks and automation, while SP(IDE)R is a methodology that works with any AI agent. Trade-off: Kiro offers tighter integration and automation at the cost of IDE lock-in; SP(IDE)R offers flexibility at the cost of manual coordination.

**vs GitHub SpecKit**: Both follow a four-phase process (Specify, Plan, Tasks, Implement). SpecKit uses slash commands (/specify, /plan, /tasks, /implement) that the AI executes autonomously. SP(IDE)R wraps implementation in IDE loops with explicit human checkpoints after each phase. Key difference: SpecKit aims for autonomous task completion; SP(IDE)R deliberately pulls humans in for review and course correction. Trade-off: SpecKit optimizes for speed and minimal interruption; SP(IDE)R optimizes for human oversight and multi-agent validation.

**Shared Goals, Different Philosophies**:
All three methodologies address the same core challenge: moving from vague prompts to reliable, production-ready code. They differ fundamentally in their approach to human involvement:
- **Kiro**: Enterprise-grade traceability and compliance (best for regulated environments)
- **SpecKit**: Autonomous execution with minimal human intervention (best for rapid prototyping)
- **SP(IDE)R**: Human-in-the-loop with deliberate review gates and multi-agent consultation by design (best for complex, evolving projects)

**Unique SP(IDE)R Features**:
- **Multi-agent by design**: Not just one AI's opinion - brings in multiple AI perspectives (GPT-5, Gemini 3 Pro) to catch blind spots
- **Human review gates**: Explicit checkpoints where humans must approve before proceeding, preventing runaway automation
- **Protocol evolution**: The methodology updates itself based on project lessons learned
- **Community-driven improvement**: Protocol improvements are shared across implementations

## What Makes Codev Different

### Installation as Documentation

We don't have installers. We have an INSTALL.md file that AI agents read and execute. Want to install Codev? Tell your AI: "Install the Codev methodology from this repo." The AI reads the instructions and sets up your project.

This isn't lazy. It's dogfooding. If natural language is code, then installation instructions should be natural language too.

### Methodology Evolution Built-In

Remember how the Review phase updates the protocol itself? Every project's lessons learned feed back into the protocol and templates. The MAINTAIN protocol automates this by syncing documentation, extracting wisdom from reviews, and keeping architecture docs current.

Your methodology evolves based on collective learning. Not theoretical improvements, but battle-tested refinements from real projects.

### Self-Hosted Development

We use Codev to build Codev. Every feature goes through SP(IDE)R. Every improvement has a specification, plan, and review. The pain points we feel become the next features we build.

Check our `codev/specs/` directory. Read the plans. Learn from our reviews. It's not just open source code; it's open source methodology.

### Context as Code

Every project has a CLAUDE.md file with project-specific guidance. Style preferences, architectural decisions, domain knowledge: all versioned, all executable. The AI doesn't just read your code; it reads your context.

## Getting Started

Want to try SP(IDE)R yourself?

1. Install: `npm install -g @cluesmith/codev`
2. Initialize: `codev init` (new project) or `codev adopt` (existing project)
3. Verify: `codev doctor`
4. Start with SPIR for structured development, or tell your AI: *"I want to build X using the SPIR protocol"*

We built a functional todo app without directly touching code, while maintaining comprehensive tests, clear architecture, and thorough documentation. You can too.

## Join the Movement

Codev is in its early stages, and we're learning from every implementation. If you try SP(IDE)R:
- Star the [GitHub repository](https://github.com/cluesmith/codev) to stay updated
- [File issues](https://github.com/cluesmith/codev/issues) with your experiences, suggestions, or questions
- Share your SP(IDE)R implementations - we analyze them to evolve the protocol
- Email us at hi@waleed.dk with feedback
- Join the conversation about the future of specification-driven development

The best methodologies emerge from collective practice, not ivory towers. Help us build the future where specifications are source code and natural language drives development.
 

