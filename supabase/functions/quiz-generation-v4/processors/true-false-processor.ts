/**
 * Stage 2: True/False Question Processor
 * 
 * Specialized processor for generating high-quality true/false questions
 * that test clear understanding of key concepts rather than trivial facts.
 * 
 * Updated to use unified LLM interface supporting both Gemini and OpenAI.
 */

import { QuestionPlan, TrueFalseQuestion, QuestionGenerationError } from '../types/interfaces.ts';
import { llmService, LLMRequest } from './llm-providers.ts';
import { QUESTION_TYPE_CONFIGS, validateResponseSchema } from './llm-schemas.ts';

// =============================================================================
// True/False-Specific Prompt (Stage 2)
// =============================================================================

export const TRUE_FALSE_DETAILED_PROMPT = `
You are an expert educational assessment designer specializing in true/false questions that test conceptual understanding. Your mission is to create a single, high-quality true/false question that reveals deep understanding rather than surface-level facts.

## EDUCATIONAL EXCELLENCE CRITERIA

### Statement Design Principles
- **Conceptual Focus**: Test understanding of key principles, not trivial facts
- **Clear Boundaries**: Statement should be unambiguously true or false based on content
- **Avoid Absolutes**: Minimize words like "always," "never," "all," unless they're essential to the concept
- **Single Concept**: Focus on one clear idea or principle
- **Meaningful Content**: Test understanding that matters for learning objectives

### True Statement Strategy
- **Core Concept**: Should represent a fundamental understanding from the content
- **Complete Accuracy**: Must be completely true based on the video content
- **Educational Value**: Understanding this truth should advance learning

### False Statement Strategy
- **Common Misconception**: Should represent a believable but incorrect understanding
- **Subtle Error**: Not obviously wrong - requires actual understanding to identify
- **Educational Trap**: Reveals specific knowledge gaps when students get it wrong
- **Plausible Alternative**: Seems reasonable without deep understanding

### Explanation Excellence
- **Educational Focus**: Explain the concept, not just the correctness
- **Misconception Addressing**: For false statements, explain why students might think it's true
- **Concept Reinforcement**: Strengthen understanding of the underlying principle
- **Learning Connection**: Connect to broader educational objectives

## QUALITY STANDARDS
- Statement tests conceptual understanding, not rote memorization
- Explanation provides educational value beyond just correctness
- Clear connection to learning objectives
- If false, addresses a meaningful misconception
- Avoids trivial or trick questions

Create a single, exceptional true/false question based on the provided question plan.
`;

// =============================================================================
// True/False Generation Function
// =============================================================================

export const generateTrueFalseQuestion = async (plan: QuestionPlan): Promise<TrueFalseQuestion> => {
  try {
    console.log(`✓ Generating True/False: ${plan.question_id}`);
    console.log(`   📚 Learning Objective: ${plan.learning_objective}`);
    console.log(`   🧠 Bloom Level: ${plan.bloom_level}`);
    console.log(`   💡 Key Concepts: ${plan.key_concepts.join(', ')}`);
    
    const contextualPrompt = buildTrueFalseContextualPrompt(plan);
    const config = QUESTION_TYPE_CONFIGS['true-false'];
    
    // Create LLM request using unified interface
    const llmRequest: LLMRequest = {
      prompt: contextualPrompt,
      responseSchema: config.schema,
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        topK: config.topK,
        topP: config.topP
      }
    };

    // Generate question using LLM service
    const response = await llmService.generateQuestion(
      'true-false',
      contextualPrompt,
      {
        ...config,
        preferredProvider: config.preferredProvider
      }
    );

    if (!response.content) {
      throw new Error('No content in LLM response');
    }

    const questionData = response.content;
    
    // Validate True/False structure
    if (!validateResponseSchema(questionData, 'true-false')) {
      throw new Error('Generated True/False question does not match expected schema');
    }
    
    validateTrueFalseStructure(questionData);
    
    // Convert to our TrueFalseQuestion interface
    const trueFalseQuestion: TrueFalseQuestion = {
      question_id: plan.question_id,
      timestamp: plan.timestamp,
      type: 'true-false',
      question: questionData.question,
      correct_answer: questionData.correct_answer,
      explanation: questionData.explanation,
      bloom_level: plan.bloom_level,
      educational_rationale: questionData.educational_rationale || plan.educational_rationale,
      concept_analysis: questionData.concept_analysis || {},
      misconception_addressed: questionData.misconception_addressed
    };
    
    console.log(`✅ True/False generated successfully: ${plan.question_id} (Provider: ${response.provider})`);
    console.log(`   🎯 Statement: ${questionData.question.substring(0, 60)}...`);
    console.log(`   ✅ Correct Answer: ${questionData.correct_answer}`);
    console.log(`   🧠 Concept: ${questionData.concept_analysis?.key_concept || 'Not specified'}`);
    
    // Log usage if available (OpenAI)
    if (response.usage) {
      console.log(`   💰 Token Usage: ${response.usage.totalTokens} total (${response.usage.promptTokens} prompt, ${response.usage.completionTokens} completion)`);
    }
    
    return trueFalseQuestion;
    
  } catch (error: unknown) {
    console.error(`❌ True/False generation failed for ${plan.question_id}:`, error);
    throw new QuestionGenerationError(
      `True/False generation failed: ${error instanceof Error ? error.message : String(error)}`,
      plan.question_id,
      { plan, stage: 'true_false_generation' }
    );
  }
};

// =============================================================================
// Helper Functions
// =============================================================================

const buildTrueFalseContextualPrompt = (plan: QuestionPlan): string => {
  return `${TRUE_FALSE_DETAILED_PROMPT}

## QUESTION PLAN CONTEXT

**Learning Objective**: ${plan.learning_objective}

**Content Context**: ${plan.content_context}

**Key Concepts to Address**: 
${plan.key_concepts.map(concept => `- ${concept}`).join('\n')}

**Target Bloom's Level**: ${plan.bloom_level}

**Educational Rationale**: ${plan.educational_rationale}

**Planning Notes**: ${plan.planning_notes}

**Video Timestamp Context**: This question appears at ${plan.timestamp} seconds in the video, addressing content around that timepoint.

## YOUR TASK

Based on this educational context, create a single, exceptional true/false question that:
1. Tests the specified learning objective at the ${plan.bloom_level} level
2. Incorporates the key concepts meaningfully  
3. Uses either a fundamental truth or a common misconception as the statement
4. Provides educational explanations that reinforce understanding

Focus on creating a statement that reveals genuine understanding rather than testing trivial facts.`;
};

const validateTrueFalseStructure = (data: any): void => {
  // Basic structure validation
  if (!data.question || typeof data.question !== 'string' || data.question.trim().length < 10) {
    throw new Error('Question must be a non-empty string of at least 10 characters');
  }
  
  if (typeof data.correct_answer !== 'boolean') {
    throw new Error('correct_answer must be a boolean (true or false)');
  }
  
  if (!data.explanation || typeof data.explanation !== 'string' || data.explanation.trim().length < 20) {
    throw new Error('Explanation must be a meaningful string of at least 20 characters');
  }
  
  // Check for question mark (should be a statement, not a question)
  if (data.question.includes('?')) {
    console.warn('⚠️ True/False should be statements, not questions');
  }
  
  // Check for absolutes that might make the question trivial
  const absolutes = ['always', 'never', 'all', 'none', 'every', 'only'];
  const hasAbsolute = absolutes.some(abs => data.question.toLowerCase().includes(abs));
  if (hasAbsolute) {
    console.warn('⚠️ Statement contains absolute terms - ensure this is educationally meaningful');
  }
  
  // Check for educational quality indicators
  const explanation = data.explanation.toLowerCase();
  if (!explanation.includes('because') && !explanation.includes('therefore') && !explanation.includes('why')) {
    console.warn('⚠️ Explanation may lack educational depth - missing explanatory language');
  }
};

// =============================================================================
// True/False Quality Assessment
// =============================================================================

export const assessTrueFalseQuality = (question: TrueFalseQuestion): {
  score: number;
  strengths: string[];
  improvements: string[];
} => {
  const strengths: string[] = [];
  const improvements: string[] = [];
  let score = 100;
  
  // Statement quality assessment
  const statementLength = question.question.length;
  if (statementLength >= 15 && statementLength <= 150) {
    strengths.push('Statement length is appropriate');
  } else if (statementLength < 15) {
    improvements.push('Statement could be more detailed');
    score -= 10;
  } else {
    improvements.push('Statement may be too complex for true/false format');
    score -= 5;
  }
  
  // Explanation quality assessment
  if (question.explanation.length >= 40) {
    strengths.push('Explanation provides good educational value');
  } else {
    improvements.push('Explanation could be more comprehensive');
    score -= 15;
  }
  
  // Educational value assessment
  if (question.concept_analysis && question.concept_analysis.key_concept) {
    strengths.push('Includes clear concept analysis');
  } else {
    improvements.push('Could benefit from concept analysis');
    score -= 10;
  }
  
  // Misconception addressing (for false statements)
  if (!question.correct_answer && question.misconception_addressed) {
    strengths.push('Addresses important misconception');
  } else if (!question.correct_answer && !question.misconception_addressed) {
    improvements.push('False statement should address specific misconception');
    score -= 10;
  }
  
  // Check for trivial true/false indicators
  const trivialIndicators = ['always', 'never', 'all', 'none'];
  const hasTrivialIndicator = trivialIndicators.some(indicator => 
    question.question.toLowerCase().includes(indicator)
  );
  
  if (hasTrivialIndicator) {
    improvements.push('Avoid absolute terms that might make question too obvious');
    score -= 5;
  } else {
    strengths.push('Avoids obvious absolute terms');
  }
  
  // Cognitive level appropriateness
  if (question.bloom_level === 'understand' || question.bloom_level === 'apply') {
    strengths.push('Targets appropriate cognitive level for true/false format');
  } else if (question.bloom_level === 'remember') {
    improvements.push('Could target higher-order thinking');
    score -= 5;
  }
  
  return {
    score: Math.max(0, score),
    strengths,
    improvements
  };
};

// =============================================================================
// Export Configuration
// =============================================================================

export const trueFalseProcessorConfig = {
  questionType: 'true-false',
  processorName: 'True/False Processor v4.0',
  stage: 2,
  requiresVideoAnalysis: false,
  supports: {
    conceptAnalysis: true,
    misconceptionTesting: true,
    educationalExplanations: true,
    qualityAssessment: true
  }
}; 