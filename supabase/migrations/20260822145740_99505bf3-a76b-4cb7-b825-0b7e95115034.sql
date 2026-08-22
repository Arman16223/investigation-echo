CREATE TABLE public.investigation_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  target TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX investigation_history_target_idx ON public.investigation_history (lower(target), created_at DESC);

GRANT ALL ON public.investigation_history TO service_role;

ALTER TABLE public.investigation_history ENABLE ROW LEVEL SECURITY;