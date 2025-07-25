import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { formatSecondsForDisplay } from '../quiz-generation-v5/utils/timestamp-converter.ts';

// Declare Deno global
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

interface InitSegmentedProcessingRequest {
  course_id: string;
  youtube_url: string;
  max_questions_per_segment?: number;
  segment_duration?: number; // Duration in seconds, default 300 (5 minutes)
  session_id?: string;
}

// Helper to extract video ID from YouTube URL
const extractVideoId = (url: string): string | null => {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
};

// Parse ISO 8601 duration to seconds
const parseISO8601Duration = (duration: string): number => {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = duration.match(regex);
  
  if (!match) return 0;
  
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  
  return hours * 3600 + minutes * 60 + seconds;
};

// Get video duration from YouTube API
const getVideoDuration = async (videoId: string): Promise<number | null> => {
  const apiKey = Deno.env.get('YOUTUBE_API_KEY');
  
  if (!apiKey) {
    console.warn('⚠️ YOUTUBE_API_KEY not found, cannot determine video duration');
    return null;
  }
  
  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=contentDetails&key=${apiKey}`
    );
    
    if (!response.ok) {
      console.error('❌ YouTube API error:', response.status);
      return null;
    }
    
    const data = await response.json();
    
    if (!data.items || data.items.length === 0) {
      console.error('❌ Video not found');
      return null;
    }
    
    const duration = data.items[0].contentDetails.duration;
    const durationInSeconds = parseISO8601Duration(duration);
    
    console.log(`📹 Video duration: ${Math.floor(durationInSeconds / 60)}m ${durationInSeconds % 60}s`);
    
    return durationInSeconds;
  } catch (error) {
    console.error('❌ Failed to fetch video duration:', error);
    return null;
  }
};

serve(async (req: Request) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const {
      course_id,
      youtube_url,
      max_questions_per_segment = 5,
      segment_duration = 300, // Default 5 minutes (reduced from 10)
      session_id
    }: InitSegmentedProcessingRequest = await req.json();

    console.log(`🎬 Initializing segmented processing for course ${course_id}`);
    console.log(`   📺 YouTube URL: ${youtube_url}`);
    console.log(`   ⏱️ Segment duration: ${segment_duration}s (${segment_duration / 60} minutes)`);
    console.log(`   ❓ Max questions per segment: ${max_questions_per_segment}`);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get video duration
    const videoId = extractVideoId(youtube_url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    const videoDuration = await getVideoDuration(videoId);
    
    // If we can't get duration, check if video is likely to be long (>10 minutes)
    // based on course metadata or use a default assumption
    let totalDuration = videoDuration || 1800; // Default to 30 minutes if unknown
    let shouldSegment = false;

    if (videoDuration) {
      shouldSegment = videoDuration > segment_duration;
    } else {
      // Ask user or make assumption based on course type
      console.warn('⚠️ Cannot determine video duration, assuming it needs segmentation');
      shouldSegment = true;
    }

    // Update course with segmentation info
    const { error: courseUpdateError } = await supabase
      .from('courses')
      .update({
        is_segmented: shouldSegment,
        total_segments: shouldSegment ? Math.ceil(totalDuration / segment_duration) : 1,
        segment_duration: segment_duration,
        // Ensure total_duration is always a valid positive integer
        total_duration: Math.max(1, Math.round(totalDuration || 0))
      })
      .eq('id', course_id);

    if (courseUpdateError) {
      throw new Error(`Failed to update course: ${courseUpdateError.message}`);
    }

    console.log(`✅ Updated course with duration: ${Math.round(totalDuration)}s (${Math.round(totalDuration / 60)}m)`);

    if (!shouldSegment) {
      console.log('📝 Video is short enough to process in one segment');
      
      // Create a single segment for consistency with the live generation pipeline
      const segments = [{
        course_id,
        segment_index: 0,
        start_time: 0,
        end_time: totalDuration,
        title: `Full Video: ${formatSecondsForDisplay(0)} - ${formatSecondsForDisplay(totalDuration)}`,
        status: 'pending'
      }];
      
      // Insert the single segment into database
      const { data: createdSegments, error: segmentsError } = await supabase
        .from('course_segments')
        .insert(segments)
        .select();

      if (segmentsError) {
        throw new Error(`Failed to create segment: ${segmentsError.message}`);
      }

      console.log('✅ Created single segment for full video');
      
      // Initialize progress tracking if session_id is provided
      if (session_id) {
        await supabase
          .from('quiz_generation_progress')
          .insert({
            course_id,
            session_id,
            stage: 'planning',
            current_step: 'Starting single segment processing',
            stage_progress: 0,
            overall_progress: 0,
            metadata: {
              total_segments: 1,
              segment_duration: totalDuration,
              video_duration: totalDuration
            }
          });
      }

      // Trigger the segment orchestrator for single segment too
      console.log('🎼 Triggering segment orchestrator for single segment');

      const orchestratorUrl = `${supabaseUrl}/functions/v1/orchestrate-segment-processing`;
      
      const orchestratorResponse = await fetch(orchestratorUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          course_id,
          check_only: false
        })
      });

      if (!orchestratorResponse.ok) {
        const errorText = await orchestratorResponse.text();
        console.error('❌ Error triggering orchestrator:', errorText);
        throw new Error(`Failed to trigger orchestrator: ${errorText}`);
      }

      const orchestratorResult = await orchestratorResponse.json();
      console.log('✅ Orchestrator triggered successfully for single segment:', orchestratorResult.status);
      
      return new Response(
        JSON.stringify({
          success: true,
          segmented: false, // Keep this false to indicate it's a single segment
          total_segments: 1,
          segment_duration: totalDuration,
          video_duration: totalDuration,
          message: 'Video will be processed as a single segment with live question generation',
          segments: [{
            index: 0,
            start_time: 0,
            end_time: totalDuration,
            title: createdSegments[0].title,
            status: 'pending'
          }]
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200 
        }
      );
    }

    // Create segments
    const totalSegments = Math.ceil(totalDuration / segment_duration);
    console.log(`📊 Creating ${totalSegments} segments for video`);

    const segments = [];
    let totalExpectedQuestions = 0;
    
    // Calculate initial segments
    const rawSegments = [];
    for (let i = 0; i < totalSegments; i++) {
      const startTime = i * segment_duration;
      const endTime = Math.min((i + 1) * segment_duration, totalDuration);
      rawSegments.push({ startTime, endTime });
    }
    
    // Check if the last segment is less than 20 seconds
    if (rawSegments.length > 1) {
      const lastSegment = rawSegments[rawSegments.length - 1];
      const lastSegmentDuration = lastSegment.endTime - lastSegment.startTime;
      
      if (lastSegmentDuration < 20) {
        console.log(`⚡ Last segment is only ${lastSegmentDuration}s, merging with previous segment`);
        // Remove the last segment
        rawSegments.pop();
        // Extend the previous segment to include the last segment's time
        rawSegments[rawSegments.length - 1].endTime = totalDuration;
      }
    }
    
    // Create segment objects
    for (let i = 0; i < rawSegments.length; i++) {
      const { startTime, endTime } = rawSegments[i];
      const segmentDurationMinutes = Math.ceil((endTime - startTime) / 60);
      const expectedQuestions = Math.min(segmentDurationMinutes, max_questions_per_segment);
      totalExpectedQuestions += expectedQuestions;
      
      console.log(`   📌 Segment ${i + 1}: ${formatSecondsForDisplay(startTime)} - ${formatSecondsForDisplay(endTime)} (${segmentDurationMinutes} min) → ${expectedQuestions} questions`);
      
      segments.push({
        course_id,
        segment_index: i,
        start_time: startTime,
        end_time: endTime,
        title: `Part ${i + 1}: ${formatSecondsForDisplay(startTime)} - ${formatSecondsForDisplay(endTime)}`,
        status: 'pending'
      });
    }
    
    console.log(`📊 Final segment count: ${segments.length} (adjusted from ${totalSegments})`);

    // Insert segments into database
    const { data: createdSegments, error: segmentsError } = await supabase
      .from('course_segments')
      .insert(segments)
      .select();

    if (segmentsError) {
      throw new Error(`Failed to create segments: ${segmentsError.message}`);
    }

    console.log(`✅ Created ${createdSegments.length} segments`);
    console.log(`   📊 Total expected questions: ${totalExpectedQuestions} (1 per minute, max ${max_questions_per_segment} per segment)`);

    // Update course with actual segment count (after merging short segments)
    const { error: updateSegmentCountError } = await supabase
      .from('courses')
      .update({
        total_segments: createdSegments.length
      })
      .eq('id', course_id);

    if (updateSegmentCountError) {
      console.error('Failed to update segment count:', updateSegmentCountError);
    }

    // Initialize progress tracking
    if (session_id) {
      await supabase
        .from('quiz_generation_progress')
        .insert({
          course_id,
          session_id,
          stage: 'planning',
          current_step: 'Starting segmented processing',
          stage_progress: 0,
          overall_progress: 0,
          metadata: {
            total_segments: createdSegments.length,
            segment_duration,
            video_duration: totalDuration
          }
        });
    }

    // Trigger the segment orchestrator instead of directly processing
    console.log(`🎼 Triggering segment orchestrator`);

    const orchestratorUrl = `${supabaseUrl}/functions/v1/orchestrate-segment-processing`;
    
    const orchestratorResponse = await fetch(orchestratorUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        course_id,
        check_only: false
      })
    });

    if (!orchestratorResponse.ok) {
      const errorText = await orchestratorResponse.text();
      console.error('❌ Error triggering orchestrator:', errorText);
      throw new Error(`Failed to trigger orchestrator: ${errorText}`);
    }

    const orchestratorResult = await orchestratorResponse.json();
    console.log('✅ Orchestrator triggered successfully:', orchestratorResult.status);

    return new Response(
      JSON.stringify({
        success: true,
        segmented: true,
        total_segments: createdSegments.length,
        segment_duration,
        video_duration: totalDuration,
        message: `Video segmented into ${createdSegments.length} parts. Processing started.`,
        segments: createdSegments.map((s: any) => ({
          index: s.segment_index,
          start_time: s.start_time,
          end_time: s.end_time,
          title: s.title,
          status: s.status
        }))
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error: any) {
    console.error('Segmented processing initialization error:', error);
    
    return new Response(
      JSON.stringify({ 
        error: error.message,
        success: false 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
 