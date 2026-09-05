ALTER TABLE anchor_batches ADD COLUMN block_number INTEGER;

UPDATE anchor_batches
SET block_number = 59626845
WHERE transaction_hash = '0xa7fcc597b6265585f38846a47b2d88dd17a2cbbc24d597085cd51c501999c695';
